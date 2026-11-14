// Self-test of lab run N (M0.11) with fake CLIs. No test starts a real claude or codex.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkInventoryStructure,
  checkJsonContent,
  checkStreamFixture,
} from "../../../tests/stream-content.ts";
import { checkEventStructure, type Leaf } from "../../../tests/stream-schema.ts";
import { openScratch } from "../agents/scratch.ts";
import { cleanEnv, liveChildren } from "../agents/spawn.ts";
import { guardCommand, guardRun } from "./guard.ts";
import { buildHelper, findCsc } from "./helper.ts";
import { stageAndPublish } from "./publish.ts";
import { eventKey, record, type CancelHow } from "./record.ts";
import { Replacer, leafValue, mergeInventories, sanitiseStream } from "./sanitise.ts";
import { descendants, parseHelperList, parseProcStat, survivors } from "./tree.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, "fake-cli.ts");
const LAB = join(HERE, "lab.ts");
const WIN = process.platform === "win32";
const NO_CSC = "no .NET Framework csc.exe on this machine, so no console-ctrl helper";

/** The value at a dotted path (array indexes as numbers), or undefined. */
const get = (value: unknown, path: string): unknown =>
  path === ""
    ? value
    : path
        .split(".")
        .reduce<unknown>(
          (v, k) =>
            typeof v === "object" && v !== null ? (v as Record<string, unknown>)[k] : undefined,
          value,
        );

let scratch = "";
let helper: string | undefined;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "tasks-m0-runs-"));
  if (WIN && findCsc() !== undefined) helper = buildHelper(join(scratch, "bin"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function fake(label: string, mode: string, stdin = "brief", cancel?: CancelHow, graceMs = 10_000) {
  return record({
    label,
    cli: "claude-print",
    // Windows: through `console-ctrl run`, which re-enables Ctrl+C for the agent, since the test
    // runner may itself have started with Ctrl+C ignored (Git Bash, a detached parent).
    file: helper ?? process.execPath,
    args: helper === undefined ? [FAKE, mode] : ["run", process.execPath, FAKE, mode],
    env: cleanEnv(process.env),
    cwd: scratch,
    stdin,
    rawDir: join(scratch, "raw"),
    timeoutMs: 60_000,
    ...(helper === undefined ? {} : { helper }),
    ...(cancel === undefined
      ? {}
      : {
          cancel: {
            how: cancel,
            trigger: (l: string) => l.includes(mode === "partial" ? '"init"' : "tool_use"),
            delayMs: mode === "partial" ? 300 : 0,
            graceMs,
          },
        }),
  });
}

const lines = (stream: string) =>
  stream
    .trimEnd()
    .split("\n")
    .map((l) => JSON.parse(l) as unknown);
const stream = (events: unknown[]) => `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;

describe("[A7.3.7.m0-runs.self-test] lab run N: recorder, cancel helpers, sanitiser", () => {
  it("records a stream: raw bytes in the raw folder, exit code, lines and event keys", async () => {
    const r = await fake("ok", "ok");
    expect(r.exit).toBe(0);
    expect(r.lines).toBe(3);
    expect(r.json_lines).toBe(3);
    expect(r.event_keys).toEqual(["system/init", "assistant", "result/success"]);
    expect(r.ends_with_newline).toBe(true);
    expect(r.partial_final_line).toBe(false);
    expect(r.raw_stdout.startsWith(join(scratch, "raw"))).toBe(true);
    expect(readFileSync(r.raw_stdout, "utf8").split("\n").length).toBe(4);
    expect(liveChildren()).toBe(0);
  });

  it("reports an empty brief as the CLI's own exit with no stdout", async () => {
    const r = await fake("brief", "brief", "");
    expect(r.exit).toBe(1);
    expect(r.lines).toBe(0);
    expect(r.stderr_bytes).toBeGreaterThan(0);
  });

  it("refuses an environment that carries agent variables", async () => {
    await expect(
      record({
        label: "leak",
        cli: "claude-print",
        file: process.execPath,
        args: [FAKE, "ok"],
        env: { ...cleanEnv(process.env), CLAUDECODE: "1" },
        cwd: scratch,
        stdin: "",
        rawDir: join(scratch, "raw"),
      }),
    ).rejects.toThrow(/refusing to pass agent variables/);
  });

  it("a missing executable leaves through the one cleanup path: no timer, no tracked child", async () => {
    const timers = () => process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;
    const before = timers();
    await expect(
      record({
        label: "missing",
        cli: "codex-exec",
        file: join(scratch, "no-such-cli.exe"),
        args: [],
        env: cleanEnv(process.env),
        cwd: scratch,
        stdin: "",
        rawDir: join(scratch, "raw"),
        timeoutMs: 3_600_000,
      }),
    ).rejects.toThrow();
    expect(timers()).toBeLessThanOrEqual(before);
    expect(liveChildren()).toBe(0);
  });

  it.skipIf(WIN)(
    "Unix: SIGINT to the group ends the turn with a result event and no process left",
    async () => {
      const r = await fake("sigint", "slow", "brief", "sigint-group");
      expect(r.exit).toBe(130);
      expect(r.event_keys.at(-1)).toBe("result/error_during_execution");
      expect(r.cancel?.escalated).toBe(false);
      expect(r.cancel?.tree_before.length).toBeGreaterThanOrEqual(2);
      expect(r.cancel?.left_after_exit).toEqual([]);
    },
  );

  it.skipIf(WIN)("Unix: a kill in mid-line leaves a partial final line", async () => {
    const r = await fake("partial", "partial", "brief", "sigterm-group");
    expect(r.partial_final_line).toBe(true);
    expect(r.ends_with_newline).toBe(false);
  });

  it.skipIf(!WIN)(
    "Windows: Ctrl+C through the console helper ends the turn, nothing is left",
    async (ctx) => {
      if (helper === undefined) ctx.skip(NO_CSC);
      const r = await fake("ctrl-c", "slow", "brief", "ctrl-c");
      expect(r.cancel?.action_class).toBe("sent");
      expect(r.exit).toBe(130);
      expect(r.event_keys.at(-1)).toBe("result/error_during_execution");
      expect(r.cancel?.tree_before.map((p) => p.exe)).toEqual(
        expect.arrayContaining(["console-ctrl.exe", "conhost.exe", "node.exe"]),
      );
      expect(r.cancel?.left_after_exit).toEqual([]);
    },
  );

  it.skipIf(!WIN)(
    "Windows: taskkill /T without /F is refused for a console process and escalates",
    async (ctx) => {
      if (helper === undefined) ctx.skip(NO_CSC);
      const r = await fake("taskkill", "slow", "brief", "taskkill-tree", 1_500);
      expect(r.cancel?.action_class).toBe("needs-force");
      expect(r.cancel?.escalated).toBe(true);
      expect(r.cancel?.left_after_exit).toEqual([]);
    },
  );

  it.skipIf(!WIN)("Windows: a kill in mid-line leaves a partial final line", async (ctx) => {
    if (helper === undefined) ctx.skip(NO_CSC);
    const r = await fake("partial", "partial", "brief", "terminate");
    expect(r.partial_final_line).toBe(true);
    expect(r.signal).toBe("SIGTERM");
  });

  it.skipIf(!WIN)(
    "Windows: the helper refuses when the console list is empty, overflows or has a stranger",
    (ctx) => {
      if (helper === undefined) ctx.skip(NO_CSC);
      const r = spawnSync(helper as string, ["selftest"], { encoding: "utf8", windowsHide: true });
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({
        zero: "RefuseList",
        overflow: "RefuseList",
        foreign: "RefuseForeign",
        own: "Send",
      });
      const list = spawnSync(helper as string, ["list"], { encoding: "utf8", windowsHide: true });
      const self = parseHelperList(list.stdout).find((p) => p.pid === process.pid);
      expect(self?.start).toMatch(/^[1-9]\d+$/);
    },
  );

  it("parses process lists and finds descendants and survivors by PID, name and start time", () => {
    expect(parseProcStat("42 (a b) c) S 7 42 42 0 0 0 0 0 0 0 0 0 0 0 20 0 1 0 98765 0")).toEqual({
      pid: 42,
      ppid: 7,
      exe: "a b) c",
      start: "98765",
    });
    const all = parseHelperList(
      '[[1,0,"root","10"],[2,1,"a.exe","11"],[3,2,"b.exe","12"],[4,9,"x.exe","13"],[5,1,"old.exe","5"]]',
    );
    // 5 claims parent 1 but started before it: a reused parent PID, not a descendant.
    expect(descendants(all, 1).map((p) => p.pid)).toEqual([1, 2, 3]);
    const now = [
      { pid: 3, ppid: 2, exe: "b.exe", start: "12" },
      { pid: 2, ppid: 1, exe: "a.exe", start: "99" },
    ];
    // 2 is a new process under the same PID and name: not a survivor.
    expect(survivors(descendants(all, 1), now).map((p) => p.pid)).toEqual([3]);
  });

  it("names events from the schema only, never by a free value", () => {
    expect(eventKey("claude-print", { type: "system", subtype: "init" })).toBe("system/init");
    expect(eventKey("claude-print", { type: "result", subtype: "acme" })).toBe(
      "result/unknown-value",
    );
    expect(eventKey("codex-exec", { type: "item.started", item: { type: "mcp_tool_call" } })).toBe(
      "item.started:mcp_tool_call",
    );
    expect(eventKey("codex-exec", { type: "item.started", item: { type: "acme_item" } })).toBe(
      "item.started:unknown-value",
    );
    expect(eventKey("claude-print", { type: "acme_private_event" })).toBe("unknown-event");
    expect(eventKey("claude-print", [1])).toBe("unknown-event");
  });

  // ---- The sanitiser: an allowed FIELD never implies an allowed VALUE (review finding 1). ----

  it("rebuilds lists, keys and IDs from fixture values: the reviewer's adversarial inputs", () => {
    const raw = stream([
      {
        type: "system",
        subtype: "init",
        cwd: "C:\\Users\\someone\\work",
        session_id: "0b8a4c38-7f2e-4f43-9b1e-2d5a6c7e8f90",
        tools: ["AcmeInternalTool", "mcp__tasks__probe_echo"],
        capabilities: ["mcp__private__inbox"],
        mcp_servers: [
          { name: "tasks", status: "connected", source: "dynamic" },
          { name: "acme-mail", status: "failed" },
        ],
        model: "gpt-acme-tenant42",
        permissionMode: "acme-mode",
        memory_paths: { "acme-notes": "C:\\Users\\someone\\notes" },
        claude_code_version: "2.1.322-acme.tenant",
        skills: ["private-skill"],
      },
      {
        type: "assistant",
        message: {
          id: 987654,
          model: 42,
          content: [{ type: "tool_use", id: 31337, name: "mcp__acme__read", input: { text: "x" } }],
        },
        request_id: 123456,
        timestamp: 1_767_000_000,
        wire_tool_inputs: { "someone@example.org": { text: "secret" } },
      },
      {
        type: "result",
        subtype: "success",
        modelUsage: {
          "gpt-acme-tenant42": { provider: "AcmeTenant", costUSD: 0.0123, inputTokens: 7 },
        },
        total_cost_usd: 0.0123,
        duration_ms: 2808,
        subagent_stats: { by_type: { "acme-agent": 2 } },
      },
      { type: "acme_private_event", subtype: "x", payload: { path: "/home/someone/secret" } },
      {
        type: "rate_limit_event",
        rate_limit_info: { rateLimitType: "seven_day", unifiedWindows: { seven_day: {} } },
      },
    ]);
    const { stream: out, inventory } = sanitiseStream("claude-print", "windows", raw);
    const [init, assistant, result, unknown, rate] = lines(out);
    expect(get(init, "tools")).toEqual(["FixtureToolA", "FixtureToolB", "mcp__tasks__probe_echo"]);
    expect(get(init, "capabilities")).toEqual(["fixture_capability_v1"]);
    expect(get(init, "mcp_servers")).toEqual([
      { name: "tasks", status: "connected", source: "dynamic" },
    ]);
    expect(get(init, "model")).toBe("fixture-model");
    expect(get(init, "permissionMode")).toBe("unknown-value");
    expect(get(init, "memory_paths")).toEqual({ "fixture-memory-1": "C:\\fixture\\path-2" });
    expect(get(init, "claude_code_version")).toBe("0.0.0");
    expect(get(init, "skills")).toEqual(["fixture-skill-a"]);
    expect(get(assistant, "message.id")).toMatch(/^msg_fixture\d{4}$/);
    // A second distinct input (a number this time) gets the next synthetic name.
    expect(get(assistant, "message.model")).toBe("fixture-model-2");
    expect(get(assistant, "message.content.0.id")).toMatch(/^toolu_fixture\d{4}$/);
    expect(get(assistant, "message.content.0.name")).toBe("unknown-value");
    expect(get(assistant, "request_id")).toMatch(/^req_fixture\d{4}$/);
    expect(get(assistant, "timestamp")).toBe("2026-01-01T00:00:00.000Z");
    expect(Object.keys(get(assistant, "wire_tool_inputs") as object)).toEqual([
      expect.stringMatching(/^toolu_fixture\d{4}$/),
    ]);
    expect(get(result, "modelUsage")).toEqual({
      "fixture-model": { provider: "fixture-provider", costUSD: 0.001, inputTokens: 100 },
    });
    expect(get(result, "total_cost_usd")).toBe(0.001);
    expect(get(result, "duration_ms")).toBe(1000);
    expect(get(result, "subagent_stats.by_type")).toEqual({ "fixture-agent-type-1": 2 });
    expect(unknown).toEqual({ type: "unknown-event" });
    expect(get(rate, "rate_limit_info.rateLimitType")).toBe("fixture_window");
    expect(Object.keys(get(rate, "rate_limit_info.unifiedWindows") as object)).toEqual([
      "fixture_window",
    ]);
    // The inventory says what was really done.
    const fields = (key: string) => inventory["claude-print"]?.[key]?.fields ?? {};
    expect(fields("assistant")["request_id"]).toEqual({
      types: ["number"],
      treatment: ["synthetic-id"],
    });
    expect(fields("assistant")["timestamp"]?.treatment).toEqual(["series-time"]);
    expect(fields("assistant")["message.model"]?.treatment).toEqual(["synthetic-name"]);
    expect(fields("system/init")["permissionMode"]?.treatment).toEqual(["placeholder"]);
    expect(fields("system/init")["tools"]?.treatment).toEqual(["rebuilt-list"]);
    expect(fields("system/init")["mcp_servers"]?.treatment).toEqual([
      "rebuilt-without-other-servers",
    ]);
    expect(Object.keys(inventory["claude-print"] ?? {})).toContain("unknown-event");
    // Every output line conforms to the schema and holds nothing of the input.
    const deny = [
      { label: "user name", value: "someone" },
      { label: "organisation", value: "acme" },
      { label: "tenant", value: "tenant" },
      { label: "skill", value: "private" },
    ];
    expect(checkStreamFixture("claude-print/windows-adversarial.jsonl", out, deny)).toEqual([]);
    expect(checkJsonContent(inventory, deny)).toEqual([]);
    expect(checkInventoryStructure(inventory)).toEqual([]);
  });

  it("every treatment holds its output for a wrong input type", () => {
    const r = new Replacer("linux");
    const cases: [Leaf, unknown, unknown][] = [
      [{ t: "enum", vocab: "stop-reason" }, 42, "unknown-value"],
      [{ t: "enum", vocab: "stop-reason" }, { acme: 1 }, "unknown-value"],
      [{ t: "bool" }, "true", null],
      [{ t: "int", min: 0, max: 10 }, "3", null],
      [{ t: "int", min: 0, max: 10 }, 2.5, null],
      [{ t: "null" }, { acme: "x" }, null],
      [{ t: "const", kind: "provider" }, 7, "fixture-provider"],
      [{ t: "name", table: "model" }, 7, "fixture-model"],
      [{ t: "path" }, { p: "/home/x" }, "/fixture/work"],
      [{ t: "version" }, 2, "0.0.0"],
      [{ t: "id", kind: "session" }, { id: "acme" }, "00000000-0000-4000-8000-000000000001"],
      [{ t: "id", kind: "item" }, 9, "item_0"],
      [{ t: "time" }, 1_767_000_000, "2026-01-01T00:00:00.000Z"],
      [{ t: "epoch" }, "2026-11-12", 1_767_225_600],
      [{ t: "text" }, { acme: 1 }, "Fixture text."],
      [{ t: "text" }, 5, "Fixture text."],
      [{ t: "error" }, { message: "acme" }, "Fixture error message (other)."],
      [{ t: "signature" }, 5, "fixture-signature"],
      [{ t: "number", kind: "tokens" }, "acme", 100],
      [{ t: "list", list: "tools" }, { a: "AcmeTool" }, []],
      [{ t: "list", list: "capabilities" }, "mcp__private__inbox", []],
    ];
    for (const [leaf, input, output] of cases) {
      expect(leafValue(leaf, input, r).out, JSON.stringify([leaf, input])).toEqual(output);
    }
    // Containers: an object where a list is expected, and keys that are e-mail addresses.
    const { stream: out } = sanitiseStream(
      "claude-print",
      "linux",
      stream([
        {
          type: "assistant",
          message: { content: { acme: "x" } },
          wire_tool_inputs: { "a@example.org": { text: "x" } },
        },
        {
          type: "result",
          subtype: "success",
          modelUsage: { "b@example.org": {} },
          subagent_stats: { by_type: { "c@example.org": 1 } },
        },
        {
          type: "rate_limit_event",
          rate_limit_info: { unifiedWindows: { "d@example.org": { status: "x" } } },
        },
      ]),
    );
    const [a, res, rate] = lines(out);
    expect(get(a, "message")).toEqual({});
    expect(Object.keys(get(a, "wire_tool_inputs") as object)[0]).toMatch(/^toolu_fixture\d{4}$/);
    expect(Object.keys(get(res, "modelUsage") as object)).toEqual(["fixture-model"]);
    expect(Object.keys(get(res, "subagent_stats.by_type") as object)).toEqual([
      "fixture-agent-type-1",
    ]);
    expect(Object.keys(get(rate, "rate_limit_info.unifiedWindows") as object)).toEqual([
      "fixture_window",
    ]);
    expect(out).not.toContain("example.org");
    for (const e of lines(out)) expect(checkEventStructure("claude-print", "linux", e)).toEqual([]);
  });

  it("an unknown variant keeps its tag as a placeholder only", () => {
    const { stream: out } = sanitiseStream(
      "codex-exec",
      "linux",
      stream([
        { type: "item.completed", item: { id: "acme-1", type: "acme_item", text: "secret" } },
        {
          type: "assistant",
          message: { content: [] },
        },
      ]),
    );
    expect(lines(out)[0]).toEqual({ type: "item.completed", item: { type: "unknown-value" } });
    expect(lines(out)[1]).toEqual({ type: "unknown-event" });
  });

  // ---- The inventory never carries a dropped name (review finding 2). ----

  it("names a field that is not on the allow-list by a placeholder with its JSON type", () => {
    const { inventory } = sanitiseStream(
      "claude-print",
      "windows",
      stream([
        {
          type: "system",
          subtype: "init",
          "client@example.org": "x",
          extra: { "private-skill": 1, list: [{ "acme-key": true }] },
        },
      ]),
    );
    const fields = inventory["claude-print"]?.["system/init"]?.fields ?? {};
    expect(Object.keys(fields).sort()).toEqual(
      [
        "<unknown-1>",
        "<unknown-2>",
        "<unknown-2>.<unknown-3>",
        "<unknown-2>.<unknown-4>",
        "<unknown-2>.<unknown-4>[]",
        "<unknown-2>.<unknown-4>[].<unknown-5>",
        "subtype",
        "type",
      ].sort(),
    );
    expect(fields["<unknown-1>"]).toEqual({ types: ["string"], treatment: ["dropped"] });
    expect(fields["<unknown-2>.<unknown-3>"]).toEqual({
      types: ["number"],
      treatment: ["dropped"],
    });
    const text = JSON.stringify(inventory);
    for (const name of ["client", "example", "extra", "private", "acme", "list"]) {
      expect(text).not.toContain(name);
    }
    expect(checkInventoryStructure(inventory)).toEqual([]);
  });

  it("publishes all or nothing: outputs are checked in the scratch folder first", () => {
    const sc = openScratch(join(scratch, "publish-scratch"));
    const dest = join(scratch, "publish-dest");
    mkdirSync(join(dest, "codex-exec"), { recursive: true });
    writeFileSync(join(dest, "codex-exec", "linux-keep.jsonl"), "before\n");
    const good = { rel: "codex-exec/linux-good.jsonl", text: '{"type":"turn.started"}\n' };
    const bad = {
      rel: "codex-exec/linux-bad.jsonl",
      text: '{"type":"error","message":"/home/someone/notes"}\n',
    };
    expect(() => stageAndPublish(sc, [good, bad], dest, [])).toThrow(/nothing was published/);
    expect(readdirSync(join(dest, "codex-exec"))).toEqual(["linux-keep.jsonl"]);
    expect(readFileSync(join(dest, "codex-exec", "linux-keep.jsonl"), "utf8")).toBe("before\n");
    const index = { rel: "index-linux.json", text: '[{"file":"codex-exec/x.jsonl","extra":1}]\n' };
    expect(() => stageAndPublish(sc, [good, index], dest, [])).toThrow(/nothing was published/);
    expect(existsSync(join(dest, "index-linux.json"))).toBe(false);
    expect(stageAndPublish(sc, [good], dest, [])).toEqual({ files: 1 });
    expect(readdirSync(join(dest, "codex-exec")).sort()).toEqual([
      "linux-good.jsonl",
      "linux-keep.jsonl",
    ]);
    // The successful stage folder is gone; the failed ones stay in the scratch folder only.
    const stages = readdirSync(sc.root).filter((n) => n.startsWith("stage-"));
    expect(stages).toHaveLength(2);
  });

  it("rebuilds a partial final line from a run, and cuts the last line on request", () => {
    const partial = sanitiseStream(
      "codex-exec",
      "linux",
      '{"type":"turn.started"}\n{"type":"item.completed","item":{"te',
    );
    expect(partial.truncated.kind).toBe("partial-from-run");
    expect(partial.stream.startsWith('{"type":"turn.started"}\n{"type":"item.completed"')).toBe(
      true,
    );
    expect(partial.stream.endsWith("\n")).toBe(false);
    const unknown = sanitiseStream("codex-exec", "linux", '{"type":"acme_secret_thing","x":"');
    expect(unknown.stream.startsWith('{"type":"unknown-event"')).toBe(true);
    const cut = sanitiseStream(
      "codex-exec",
      "linux",
      '{"type":"turn.started"}\n{"type":"turn.started"}\n',
      { cutFinalLine: true },
    );
    expect(cut.truncated.kind).toBe("cut-by-sanitiser");
    expect(cut.stream).toBe('{"type":"turn.started"}\n{"type":"tu');
    expect(sanitiseStream("codex-exec", "linux", "").truncated.kind).toBe("empty");
  });

  it("merges inventories", () => {
    const a = sanitiseStream("codex-exec", "linux", '{"type":"turn.started","x":1}\n').inventory;
    const b = sanitiseStream("codex-exec", "linux", '{"type":"turn.started","x":"s"}\n').inventory;
    const m = mergeInventories([a, b]);
    expect(m["codex-exec"]?.["turn.started"]?.count).toBe(2);
    expect(m["codex-exec"]?.["turn.started"]?.fields["<unknown-1>"]?.types).toEqual([
      "number",
      "string",
    ]);
  });

  // ---- The machine rule is code (review finding 4). ----

  it("refuses desktop-only commands and full access off Windows, before anything starts", () => {
    for (const c of ["build-helper", "n01", "n02", "n03", "n03-detached", "repeats", "cleanup"]) {
      expect(() => {
        guardCommand(c, false);
      }).toThrow(/desktop-only/);
      expect(() => {
        guardCommand(c, true);
      }).not.toThrow();
    }
    for (const c of ["n02-laptop", "n05", "resanitise", "keys"]) {
      expect(() => {
        guardCommand(c, false);
      }).not.toThrow();
    }
    const full = ["exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "-"];
    expect(() => {
      guardRun("codex", full, false);
    }).toThrow(/full access/);
    expect(() => {
      guardRun("codex", ["exec", "--json", "-"], false);
    }).not.toThrow();
    expect(() => {
      guardRun("claude", ["-p"], false);
    }).toThrow(/desktop-only/);
    expect(() => {
      guardRun("codex", full, true);
    }).not.toThrow();
  });

  it.skipIf(WIN)("Linux: the lab refuses n02 before it creates a folder or a process", () => {
    const sc = join(scratch, "guard-scratch");
    const r = spawnSync(process.execPath, [LAB, "n02", "--scratch", sc], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("error: a desktop-only command on a non-Windows host\n");
    expect(existsSync(sc)).toBe(false);
  });

  // ---- Nothing a CLI wrote reaches the console, the results or the fixtures (finding 3). ----

  it("keeps CLI text, errors and events with private values in the scratch folder only", (ctx) => {
    if (WIN && findCsc() === undefined) ctx.skip(NO_CSC);
    const root = join(scratch, "leak");
    const fakes = join(root, "fakes");
    const results = join(root, "results");
    const fixtures = join(root, "fixtures");
    for (const d of [fakes, results, fixtures]) mkdirSync(d, { recursive: true });
    const S = {
      user: "zqsentineluser",
      winHome: "C:\\Users\\zqsentineluser\\notes",
      linuxHome: "/home/zqsentineluser/notes",
      email: "zq.sentinel@example.org",
      token: "sk-ant-api03-ZQsentinelTOKEN0123456789abcdef",
      server: "zq-private-server",
    };
    const all = Object.values(S).join(" ");
    const common = `
      const S = ${JSON.stringify(S)};
      const all = ${JSON.stringify(all)};
      const emit = (e) => process.stdout.write(JSON.stringify(e) + "\\n");
      const argv = process.argv.slice(2);
      let input = "";
      process.stdin.setEncoding("utf8").on("data", (d) => (input += d));
    `;
    writeFileSync(
      join(fakes, "claude.mjs"),
      `${common}
      process.stdin.on("end", () => {
        process.stderr.write("error for " + all + "\\n");
        if (input.trim() === "") process.exit(1);
        const sid = argv[argv.indexOf("--session-id") + 1] ?? "x";
        emit({ type: "system", subtype: "init", cwd: S.winHome, session_id: sid, model: "zq-model",
          tools: ["mcp__" + S.server + "__inbox", "mcp__tasks__probe_echo"],
          mcp_servers: [{ name: S.server, status: "connected" }, { name: "tasks", status: S.user }],
          permissionMode: S.user, [S.email]: S.token, skills: [S.user] });
        emit({ type: "zq_private_event", payload: all });
        emit({ type: "assistant", message: { model: "zq-model", content: [
          { type: "tool_use", id: S.token, name: "mcp__" + S.server + "__read", input: { text: all } }] } });
        emit({ type: "result", subtype: S.user, is_error: S.email, result: all, errors: [all],
          num_turns: S.user, session_id: sid, modelUsage: { [S.email]: { provider: S.server } } });
        process.exit(0);
      });`,
    );
    writeFileSync(
      join(fakes, "codex.mjs"),
      `${common}
      import { writeFileSync } from "node:fs";
      process.stdin.on("end", () => {
        process.stderr.write("error for " + all + "\\n");
        const o = argv.indexOf("-o");
        if (o >= 0) writeFileSync(argv[o + 1], all);
        if (input.trim() === "") process.exit(1);
        emit({ type: "thread.started", thread_id: "019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5b" });
        emit({ type: "turn.started" });
        emit({ type: "item.completed", item: { id: S.user, type: "mcp_tool_call", server: S.server,
          tool: S.user, status: "completed", error: { message: all } } });
        emit({ type: "item.completed", item: { id: "item_9", type: "zq_item", text: all } });
        emit({ type: "error", message: all, [S.email]: S.linuxHome });
        emit({ type: "turn.failed", error: { message: all } });
        process.exit(1);
      });`,
    );
    const lab = (...a: string[]) =>
      spawnSync(process.execPath, [LAB, ...a], {
        encoding: "utf8",
        env: { ...process.env, TASKS_M0_TEST_CLIS: fakes },
        timeout: 300_000,
      });
    const sc = ["--scratch", join(root, "scratch"), "--results", results];
    const runs = WIN
      ? [lab("build-helper", ...sc), lab("n01", ...sc), lab("n02", ...sc)]
      : [lab("n02-laptop", ...sc)];
    runs.push(lab("n05", ...sc, "--fixtures", fixtures));
    for (const r of runs) expect(r.stderr, r.stdout).toBe("");
    for (const r of runs) expect(r.status).toBe(0);
    const tree = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? tree(p) : [readFileSync(p, "utf8")];
      });
    const outputs = [
      ...runs.flatMap((r) => [r.stdout, r.stderr]),
      ...tree(results),
      ...tree(fixtures),
    ];
    expect(tree(fixtures).length).toBeGreaterThan(2);
    const needles = [
      "zqsentinel",
      "zq.sentinel",
      "zq-private-server",
      "zq_private_event",
      "zq_item",
      "zq-model",
    ];
    for (const text of outputs) {
      for (const n of needles) expect(text.toLowerCase()).not.toContain(n.toLowerCase());
    }
    // The raw stream, in the scratch folder, did carry them.
    const raw = join(root, "scratch", "raw");
    expect(tree(raw).join("\n")).toContain("zqsentinel");
  }, 300_000);

  it("the raw folder is the only place the recorder writes", () => {
    expect(existsSync(join(scratch, "raw", "ok.stdout.jsonl"))).toBe(true);
    expect(existsSync(join(HERE, "raw"))).toBe(false);
  });
});
