// Self-test of the M0.09 lab code: the clean spawner, the probe and the key-level config
// recorder. A fake CLI stands in for claude and codex, so this runs in CI where neither exists;
// no test starts a real agent CLI or a model session.
import { spawn } from "node:child_process";
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
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sha256Hex } from "../kit/wire.ts";
import {
  compareRecords,
  entryRecord,
  jsonKeys,
  recordFiles,
  recordHome,
  realHomeKeys,
  tomlKeys,
} from "./config-record.ts";
import { divisorFor, estimate, share } from "./corpus.ts";
import { idFormat, metaKey, startFacts } from "./probe.ts";
import {
  OWNER_MARKER,
  ScratchRefusal,
  isStrictlyInside,
  openScratch,
  parseE02Modes,
} from "./scratch.ts";
import { cleanEnv, endAll, forbiddenNames, liveChildren, run } from "./spawn.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = join(HERE, "probe.ts");
const LAB = join(HERE, "lab.ts");
// Made in beforeAll, not at import: collecting this file (the manifest check lists every test)
// must not leave a folder behind.
let tmp = "";
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "m0-agents-"));
});
afterAll(() => {
  // The test's own temporary folder (mkdtemp under the OS temp folder), nothing else.
  if (resolve(dirname(tmp)) === resolve(tmpdir()) && basename(tmp).startsWith("m0-agents-")) {
    rmSync(tmp, { recursive: true, force: true });
  }
});

const alive = (pid: number | undefined): boolean => {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Runs lab.ts as a program, as the lab runs it, with extra variables for the test. */
const labRun = (argv: string[], extra: Record<string, string> = {}) =>
  run(process.execPath, [LAB, ...argv], {
    env: { ...cleanEnv(process.env), TTASKS_M0_LINUX_CLAUDE: "1", ...extra },
    cwd: tmp,
    timeoutMs: 120_000,
  });

/** A user name, a home path on each OS, an e-mail address and a token-shaped string. */
const SENTINELS = [
  "sentinel-user-q7x",
  "C:\\Users\\SentinelQ7\\secret.txt",
  "/home/sentinelq7/.ssh/id_ed25519",
  "q7.sentinel@example.invalid",
  "sk-ant-oat01-Q7SENTINEL0123456789abcdefABCDEF",
];

const FAKE_HEAD = `
const S = ${JSON.stringify(SENTINELS)};
const all = S.join(" ");
const args = process.argv.slice(2);
process.stderr.write("fatal: " + all + "\\n");
if (args[0] === "mcp") { console.log(all); process.exit(0); }
console.log("not json " + all);
`;

/** A fake claude -p: error result, answer text, model names and stderr all carry sentinels. */
const FAKE_CLAUDE = `${FAKE_HEAD}
if (args.includes("stream-json")) {
  console.log(JSON.stringify({ type: "system", subtype: "init", cwd: S[2], tools: ["mcp__tasks-probe__probe_marked", "mcp__" + S[0] + "__x"] }));
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__" + S[0] + "__t", input: { a: all } }, { type: "text", text: all }] } }));
}
console.log(JSON.stringify({
  type: "result", subtype: "error " + S[0], is_error: S[0], num_turns: S[3],
  result: "marked=" + S[0] + " plain=" + S[0] + " " + all,
  usage: { input_tokens: 10, cache_creation_input_tokens: S[4], cache_read_input_tokens: 5 },
  modelUsage: { "claude-haiku-5-5": {}, [S[0]]: {}, ["claude-" + S[0]]: {} },
  session_id: S[0],
}));
process.exit(1);
`;

/** A fake codex exec --json: error events, items, answer and usage carry sentinels. */
const FAKE_CODEX = `${FAKE_HEAD}
const ev = (e) => console.log(JSON.stringify(e));
ev({ type: "thread.started", thread_id: "019a0000-0000-7000-8000-000000000001" });
ev({ type: "item.completed", item: { id: S[0], type: "agent_message", text: "M001 " + all } });
ev({ type: "item.completed", item: { type: "mcp_tool_call", server: S[0], tool: "probe_" + S[0], status: S[0], error: { message: all } } });
ev({ type: "item.completed", item: { type: "command_execution", command: all, aggregated_output: all, exit_code: 1, status: "failed" } });
ev({ type: "item.completed", item: { type: "type_" + S[0], text: all } });
ev({ type: "error", message: all });
ev({ type: "turn.failed", error: { message: all } });
ev({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: S[4], [S[0]]: 1 } });
process.exit(1);
`;

const TICKET = "kt_0123456789abcdef0123456789abcdef";
const SESSION = "6f1c2b9e-3d4a-4e5f-8a7b-0c1d2e3f4a5b";
const POLLUTED = {
  ...process.env,
  CLAUDECODE: "1",
  CLAUDE_CODE_SESSION_ID: "11111111-2222-4333-8444-555555555555",
  CLAUDE_CODE_ENTRYPOINT: "cli",
  ANTHROPIC_MODEL: "x",
  CODEX_THREAD_ID: "t",
  T3CODE_THREAD_ID: "t",
  MCP_TIMEOUT: "1",
  OPENAI_BASE_URL: "x",
  SOMETHING_ELSE: "x",
};

/** A fake agent CLI: `mcp add|get|list|remove` against <CLAUDE_CONFIG_DIR>/.claude.json. */
const FAKE_CLI = `
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const file = join(process.env.CLAUDE_CONFIG_DIR, ".claude.json");
const read = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { firstStart: 1 });
const write = (c) => writeFileSync(file, JSON.stringify(c, null, 2));
const [, , group, verb, name, ...rest] = process.argv;
const config = read();
if (verb === "add") {
  const at = rest.indexOf("--");
  config.mcpServers ??= {};
  config.mcpServers[name] = { type: "stdio", command: rest[at + 1], args: rest.slice(at + 2), env: {} };
  write(config);
} else if (verb === "remove") {
  delete config.mcpServers[name];
  write(config);
} else if (verb === "list") {
  write(config);
  for (const [n, s] of Object.entries(config.mcpServers ?? {})) {
    const child = spawn(s.command, s.args, { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, CLAUDE_CODE_SESSION_ID: "${SESSION}" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.322" } } }) + "\\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: { progressToken: 1 } } }) + "\\n");
    child.stdout.once("data", () => { console.log(n + ": connected"); child.stdin.end(); });
  }
}
`;

describe("[A7.3.7.m0-agents.self-test] the M0.09 lab code", () => {
  test("the clean environment holds the allow-list and the extras only", () => {
    const env = cleanEnv(POLLUTED, { TTASKS_TICKET: TICKET }, { path: "/bin" });
    expect(forbiddenNames(env)).toEqual([]);
    expect(env["TTASKS_TICKET"]).toBe(TICKET);
    expect(env["PATH"]).toBe("/bin");
    expect(env["SOMETHING_ELSE"]).toBeUndefined();
    expect(() => cleanEnv(POLLUTED, { CLAUDECODE: "1" } as never)).toThrow(/not an allowed/);
    expect(
      forbiddenNames({ CLAUDE_CODE_X: "1", TTASKS_TICKET: "t", CLAUDE_CONFIG_DIR: "d" }),
    ).toEqual(["CLAUDE_CODE_X"]);
    // Windows: one variable whatever its case.
    const win = cleanEnv({ Path: "a", SystemRoot: "r" }, {}, { win: true, path: "b" });
    expect(win).toEqual({ PATH: "b", SystemRoot: "r" });
  });

  test("run refuses a forbidden name, and a child started through it sees none", async () => {
    await expect(
      run(process.execPath, ["-e", ""], { env: { CLAUDECODE: "1" }, cwd: tmp }),
    ).rejects.toThrow(/refusing/);
    const script =
      "console.log(JSON.stringify(Object.keys(process.env).filter(n=>/^(CLAUDECODE|CLAUDE_CODE_|ANTHROPIC_|CODEX_|T3CODE_|MCP_|OPENAI_)/i.test(n))))";
    const r = await run(process.execPath, ["-e", script], {
      env: cleanEnv(POLLUTED, { TTASKS_TICKET: TICKET }),
      cwd: tmp,
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([]);
  });

  test("the probe records names, matches and formats, never values", async () => {
    const out = join(tmp, "probe");
    const expectFile = join(tmp, "expect.json");
    writeFileSync(
      expectFile,
      JSON.stringify({
        ticket_sha256: sha256Hex(TICKET),
        ids: { CLAUDE_CODE_SESSION_ID: SESSION },
      }),
    );
    const child = spawn(
      process.execPath,
      [PROBE, "--out", out, "--label", "t1", "--expect", expectFile],
      {
        env: {
          ...cleanEnv(process.env),
          TTASKS_TICKET: TICKET,
          CLAUDE_CODE_SESSION_ID: SESSION,
          CODEX_THREAD_ID: "019a-thread-abcdef",
        },
        stdio: ["pipe", "pipe", "inherit"],
      },
    );
    const replies: string[] = [];
    child.stdout.setEncoding("utf8").on("data", (d: string) => replies.push(d));
    const send = (m: object) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "codex-mcp-client", version: "0.167.2" },
      },
    });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "probe_echo",
        arguments: { text: "Mira" },
        _meta: { threadId: "019a-thread-abcdef", "odd key!": 1 },
      },
    });
    await new Promise((r) => setTimeout(r, 1500));
    child.stdin.end();
    await new Promise((r) => child.on("close", r));
    const files = readdirSync(out).filter((f) => f.startsWith("probe-t1-"));
    expect(files).toHaveLength(1);
    const text = readFileSync(join(out, files[0] ?? ""), "utf8");
    const record = JSON.parse(text) as Record<string, unknown>;
    expect(record["ticket"]).toEqual({ present: true, equal: true });
    expect((record["ids"] as Record<string, unknown>)["CLAUDE_CODE_SESSION_ID"]).toEqual({
      present: true,
      equal: true,
      format: { length: 36, class: "uuid" },
    });
    expect(record["initialize"]).toEqual({
      protocol_version: "2025-11-25",
      client: "codex-mcp-client",
      client_version: "0.167.2",
    });
    expect(record["tool_calls"]).toEqual(["probe_echo"]);
    expect((record["meta_keys"] as Record<string, string[]>)["tools/call"]).toContain("threadId");
    for (const value of [TICKET, SESSION, "019a-thread-abcdef", "Mira"])
      expect(text).not.toContain(value);
    expect(replies.join("")).toContain("probe: probe_echo ok");
  });

  test("probe helpers: ID formats, meta keys, facts without an expectation", () => {
    expect(idFormat(SESSION)).toEqual({ length: 36, class: "uuid" });
    expect(idFormat("abc123")).toEqual({ length: 6, class: "hex" });
    expect(idFormat("a b")).toEqual({ length: 3, class: "other" });
    expect(metaKey("io.modelcontextprotocol/clientInfo")).toBe(
      "io.modelcontextprotocol/clientInfo",
    );
    expect(metaKey("bad key")).toMatch(/^\[other:/);
    const facts = startFacts({ CODEX_THREAD_ID: "t-1", PATH: "x" }, {});
    expect(facts["env_present"]).toEqual(["CODEX_THREAD_ID", "PATH"]);
    expect((facts["pending"] as Record<string, string>)["CODEX_THREAD_ID"]).toBe(
      sha256Hex("t-1").slice(0, 12),
    );
  });

  test("the recorder lists keys, sees changed values and proves exact removal through a fake CLI", async () => {
    const home = join(tmp, "home");
    mkdirSync(home, { recursive: true });
    const cli = join(tmp, "fake-cli.mjs");
    writeFileSync(cli, FAKE_CLI);
    const out = join(tmp, "probe-fake");
    const env = cleanEnv(POLLUTED, { CLAUDE_CONFIG_DIR: home, TTASKS_TICKET: TICKET });
    const fake = (...argv: string[]) => run(process.execPath, [cli, ...argv], { env, cwd: tmp });
    await fake("mcp", "list");
    const base = recordHome(home);
    await fake(
      "mcp",
      "add",
      "ttasks-probe",
      "--",
      process.execPath,
      PROBE,
      "--out",
      out,
      "--label",
      "fake",
    );
    const added = recordHome(home);
    expect(compareRecords(base, added).keys_added[".claude.json"]).toContain(
      "mcpServers.ttasks-probe.command",
    );
    const listed = await fake("mcp", "list");
    expect(listed.stdout).toContain("ttasks-probe: connected");
    await new Promise((r) => setTimeout(r, 500));
    const probe = readdirSync(out).filter((f) => f.startsWith("probe-fake-"));
    const record = JSON.parse(readFileSync(join(out, probe[0] ?? ""), "utf8")) as Record<
      string,
      unknown
    >;
    expect(record["env_present"]).toContain("TTASKS_TICKET");
    expect(record["env_present"]).not.toContain("CLAUDECODE");
    expect(record["env_present"]).toContain("CLAUDE_CODE_SESSION_ID");
    await fake("mcp", "remove", "ttasks-probe");
    const removed = recordHome(home);
    const first = compareRecords(base, removed);
    // Like Claude Code, the fake CLI leaves an empty mcpServers object behind.
    expect(first.restored).toBe(false);
    expect(first.keys_added[".claude.json"]).toEqual(["mcpServers"]);
    await fake("mcp", "add", "ttasks-probe", "--", process.execPath, PROBE);
    await fake("mcp", "remove", "ttasks-probe");
    expect(compareRecords(removed, recordHome(home)).restored).toBe(true);
    // A changed value shows by key name only.
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ firstStart: 2, mcpServers: {} }));
    expect(compareRecords(removed, recordHome(home)).values_changed[".claude.json"]).toEqual([
      "firstStart",
    ]);
  });

  test("TOML and JSON key lists, and the real-home key reader", () => {
    const toml =
      '# c\nmodel = "x"\n[mcp_servers.ttasks]\ncommand = \'C:\\k\\ttasks.exe\'\nargs = ["mcp"]\nenv_vars = ["TTASKS_TICKET"]\n[mcp_servers."a.b".env]\nK = "v"\ns = """\nmulti = 1\n"""\n';
    expect(tomlKeys(toml)).toEqual([
      "model",
      "mcp_servers.ttasks",
      "mcp_servers.ttasks.command",
      "mcp_servers.ttasks.args",
      "mcp_servers.ttasks.env_vars",
      'mcp_servers."a.b".env',
      'mcp_servers."a.b".env.K',
      'mcp_servers."a.b".env.s',
    ]);
    expect(jsonKeys({ a: { b: 1, c: [1] } })).toEqual(["a", "a.b", "a.c"]);
    const dir = join(tmp, "real");
    mkdirSync(join(dir, ".codex"), { recursive: true });
    writeFileSync(
      join(dir, ".claude.json"),
      JSON.stringify({
        mcpServers: { tasks: {} },
        projects: { "/w": {}, "/x": {} },
        oauthAccount: { secret: 1 },
      }),
    );
    writeFileSync(join(dir, ".codex", "config.toml"), toml);
    expect(
      realHomeKeys(join(dir, ".claude.json"), join(dir, ".codex", "config.toml"), "/w"),
    ).toEqual({
      claude_user_mcp_servers: ["tasks"],
      claude_project_count: 2,
      claude_project_entry_for_work: true,
      codex_mcp_servers: ["a.b", "tasks"],
    });
  });

  // Finding 6 of the M0.09 review: every file the caller names is compared, and a named file
  // that is missing from the comparison makes `restored` false.
  test("the recorder compares every named file, Claude Desktop's configuration included", () => {
    const home = join(tmp, "desktop-home");
    mkdirSync(home, { recursive: true });
    const desktop = join(home, "claude_desktop_config.json");
    writeFileSync(desktop, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    writeFileSync(join(home, "notes.txt"), "a");
    const named = ["claude_desktop_config.json", "config.toml"];
    writeFileSync(join(home, "config.toml"), '[mcp_servers.other]\ncommand = "y"\n');
    const before = recordHome(home, named);
    expect(Object.keys(before.config).sort()).toEqual(named.slice().sort());
    // The reviewer's case: only Claude Desktop's file changes.
    writeFileSync(desktop, JSON.stringify({ mcpServers: { other: { command: "x" }, tasks: {} } }));
    const changed = compareRecords(before, recordHome(home, named));
    expect(changed.restored).toBe(false);
    expect(changed.bytes_equal["claude_desktop_config.json"]).toBe(false);
    expect(changed.bytes_equal["config.toml"]).toBe(true);
    expect(changed.keys_added["claude_desktop_config.json"]).toContain("mcpServers.ttasks");
    // Without naming it, the whole-home hashes still catch it.
    const plainBefore = recordHome(home);
    writeFileSync(desktop, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    const plain = compareRecords(plainBefore, recordHome(home));
    expect(plain.restored).toBe(false);
    expect(plain.files_changed).toEqual(["claude_desktop_config.json"]);
    // A change to a file the parser does not know is caught too.
    const again = recordHome(home);
    writeFileSync(join(home, "notes.txt"), "b");
    expect(compareRecords(again, recordHome(home)).files_changed).toEqual(["notes.txt"]);
    // A named file absent before and after cannot be vouched for.
    const absent = compareRecords(recordHome(home, ["settings.json"]), recordHome(home));
    expect(absent.missing).toEqual(["settings.json"]);
    expect(absent.restored).toBe(false);
    // Unchanged named files: restored.
    expect(compareRecords(recordHome(home, named), recordHome(home, named)).restored).toBe(true);
    // A real home: only the named files are read, nothing else in the folder.
    const real = recordFiles(home, ["claude_desktop_config.json", "absent.json"]);
    expect(real.files).toEqual(["claude_desktop_config.json"]);
    expect(Object.keys(real.hashes)).toEqual(["claude_desktop_config.json"]);
    writeFileSync(desktop, JSON.stringify({ mcpServers: {} }));
    const realAfter = compareRecords(
      real,
      recordFiles(home, ["claude_desktop_config.json", "absent.json"]),
    );
    expect(realAfter.restored).toBe(false);
    expect(realAfter.bytes_equal["claude_desktop_config.json"]).toBe(false);
    expect(realAfter.missing).toEqual(["absent.json"]);
  });

  test("the entry record keeps TTasks's key paths only, with file hashes for the concurrency check", () => {
    const file = join(tmp, "entry", "claude_desktop_config.json");
    mkdirSync(dirname(file), { recursive: true });
    const secret = "other-servers-secret-value";
    writeFileSync(
      file,
      JSON.stringify({ mcpServers: { other: { env: { TOKEN: secret } } }, theme: "dark" }),
    );
    const record = entryRecord(file, ["mcpServers.ttasks"]);
    expect(record.entries).toEqual({ "mcpServers.ttasks": { present: false } });
    expect(record.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(record)).not.toContain(secret);
    expect(JSON.stringify(record)).not.toContain("dark");
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: { other: { env: { TOKEN: secret } }, tasks: { command: "k" } },
        theme: "dark",
      }),
    );
    const after = entryRecord(file, ["mcpServers.ttasks"]);
    expect(after.entries["mcpServers.ttasks"]).toEqual({ present: true, value: { command: "k" } });
    expect(after.sha256).not.toBe(record.sha256);
    expect(JSON.stringify(after)).not.toContain(secret);
    const toml = join(tmp, "entry", "config.toml");
    writeFileSync(
      toml,
      '[mcp_servers.other]\nenv = { K = "v" }\n[mcp_servers.ttasks]\ncommand = "k"\n',
    );
    const t = entryRecord(toml, ["mcp_servers.ttasks.command", "mcp_servers.ttasks.env_vars"]);
    expect(t.entries).toEqual({
      "mcp_servers.ttasks.command": { present: true, value: '"k"' },
      "mcp_servers.ttasks.env_vars": { present: false },
    });
    expect(entryRecord(join(tmp, "entry", "none.json"), ["a"])).toEqual({
      sha256: null,
      entries: { a: { present: false } },
    });
  });

  // Finding 1: one removal rule for the whole lab.
  test("the removal rule refuses the root, anything above it, a sibling and an unmarked folder", () => {
    const base = join(tmp, "rm-rule");
    mkdirSync(base, { recursive: true });
    const root = join(base, "m0-09");
    const sibling = join(base, "m0-09x");
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "keep.txt"), "keep");
    writeFileSync(join(base, "parent-keep.txt"), "keep");
    const sc = openScratch(root);
    expect(readFileSync(join(root, OWNER_MARKER), "utf8")).toContain(sc.runId);
    // A re-open reads the same run.
    expect(openScratch(root).runId).toBe(sc.runId);
    expect(() => {
      sc.remove(root);
    }).toThrow(ScratchRefusal);
    expect(() => {
      sc.remove(join(root, "."));
    }).toThrow(ScratchRefusal);
    expect(() => {
      sc.remove(base);
    }).toThrow(ScratchRefusal);
    expect(() => {
      sc.remove(join(root, ".."));
    }).toThrow(ScratchRefusal);
    expect(() => {
      sc.remove(sibling);
    }).toThrow(ScratchRefusal);
    expect(() => {
      sc.remove(join(root, "..", "m0-09x"));
    }).toThrow(ScratchRefusal);
    // The hostile E02 mode: refused as a mode, and its path would be the scratch root's parent.
    expect(() => parseE02Modes("x/../../..", true)).toThrow(ScratchRefusal);
    expect(() => parseE02Modes("state,../x", false)).toThrow(ScratchRefusal);
    expect(parseE02Modes(undefined, true)).toEqual(["state"]);
    expect(parseE02Modes("run-user,state", false)).toEqual(["run-user", "state"]);
    expect(() => {
      sc.remove(join(root, "e02-svc", "state-x/../../.."));
    }).toThrow(ScratchRefusal);
    // A folder inside that the run did not create (no marker) is refused.
    mkdirSync(join(root, "foreign"), { recursive: true });
    expect(() => {
      sc.remove(join(root, "foreign"));
    }).toThrow(ScratchRefusal);
    // A folder of another run (a marker with another ID) is refused.
    mkdirSync(join(root, "other-run"), { recursive: true });
    writeFileSync(
      join(root, "other-run", OWNER_MARKER),
      JSON.stringify({ lab: "m0-09", run: "another" }),
    );
    expect(() => {
      sc.remove(join(root, "other-run"));
    }).toThrow(ScratchRefusal);
    // The run's own folder goes; a reserved folder a child creates is claimed first.
    const own = sc.mkdir(join(root, "homes", "claude-a01"));
    writeFileSync(join(own, "f.json"), "{}");
    sc.remove(own);
    expect(existsSync(own)).toBe(false);
    const state = sc.reserve(join(root, "svc", "state"));
    expect(() => sc.reserve(join(root, "foreign"))).toThrow(ScratchRefusal);
    mkdirSync(state, { recursive: true });
    sc.claim(state);
    sc.remove(state);
    expect(existsSync(state)).toBe(false);
    expect(() => {
      sc.claim(join(root, "foreign"));
    }).toThrow(ScratchRefusal);
    // Files strictly inside go; a missing target is a no-op.
    writeFileSync(join(root, "file.json"), "{}");
    sc.remove(join(root, "file.json"));
    sc.remove(join(root, "never-there"));
    // Everything outside is untouched.
    expect(readFileSync(join(sibling, "keep.txt"), "utf8")).toBe("keep");
    expect(readFileSync(join(base, "parent-keep.txt"), "utf8")).toBe("keep");
    expect(existsSync(join(root, "foreign"))).toBe(true);
    // An existing folder without the marker is not adopted as a scratch root unless empty.
    expect(() => openScratch(sibling)).toThrow(ScratchRefusal);
  });

  test("strictly inside: resolution, case on Windows, prefixes", () => {
    expect(
      isStrictlyInside("C:\\Users\\M\\Scratch\\s-09", "c:\\users\\m\\SCRATCH\\s-09\\a", true),
    ).toBe(process.platform === "win32");
    expect(isStrictlyInside("/s/m0-09", "/s/m0-09/a/../b")).toBe(true);
    expect(isStrictlyInside("/s/m0-09", "/s/m0-09/a/../..")).toBe(false);
    expect(isStrictlyInside("/s/m0-09", "/s/m0-09")).toBe(false);
    expect(isStrictlyInside("/s/m0-09", "/s/m0-09-other")).toBe(false);
    expect(isStrictlyInside("/s/m0-09", "/s")).toBe(false);
  });

  test.skipIf(process.platform !== "win32")("on Windows the root compares without case", () => {
    const root = join(tmp, "CaseRoot");
    const sc = openScratch(root);
    const dir = sc.mkdir(join(tmp, "caseroot", "Sub"));
    sc.remove(dir.toUpperCase());
    expect(existsSync(dir)).toBe(false);
    expect(() => {
      sc.remove(root.toUpperCase());
    }).toThrow(ScratchRefusal);
  });

  test("the lab refuses a hostile E02 mode before it touches anything", async () => {
    const base = join(tmp, "e02-hostile");
    const scratchDir = join(base, "s", "m0-09");
    mkdirSync(join(base, "canary"), { recursive: true });
    writeFileSync(join(base, "canary", "keep.txt"), "keep");
    const r = await labRun(["e02", "--scratch", scratchDir], { TTASKS_M0_E02_MODES: "x/../../.." });
    expect(r.code).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("error: unknown E02 mode");
    expect(`${r.stdout}${r.stderr}`).not.toContain(base);
    expect(readFileSync(join(base, "canary", "keep.txt"), "utf8")).toBe("keep");
    expect(existsSync(scratchDir)).toBe(true);
  });

  // Finding 2: facts only in anything the lab code prints or writes.
  test("no CLI output reaches the lab's logs or files: sentinels in errors, answers and stderr", async () => {
    const fakes = join(tmp, "fake-clis");
    mkdirSync(fakes, { recursive: true });
    writeFileSync(join(fakes, "claude.mjs"), FAKE_CLAUDE);
    writeFileSync(join(fakes, "codex.mjs"), FAKE_CODEX);
    const scratchDir = join(tmp, "facts-run", "m0-09");
    let printed = "";
    for (const command of [
      "a01-sessions",
      "a02-sessions",
      "a06",
      "a06-length",
      "a06-markers",
      "a09",
    ]) {
      const r = await labRun([command, "--scratch", scratchDir], {
        TTASKS_M0_TEST_CLIS: fakes,
        TTASKS_M0_A09_VARIANTS: "describe-default",
        TTASKS_M0_A06_LENGTHS: "200,400",
        TTASKS_M0_A06_REPEATS: "1",
      });
      printed += r.stdout + r.stderr;
      expect(r.code, command).toBe(0);
    }
    for (const s of SENTINELS) expect(printed).not.toContain(s);
    expect(printed).not.toMatch(/sentinel/i);
    const files: string[] = [];
    const walkAll = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walkAll(p);
        else files.push(p);
      }
    };
    walkAll(scratchDir);
    expect(files.some((f) => f.endsWith("a06-headless.json"))).toBe(true);
    expect(files.some((f) => f.endsWith("a06-codex-instructions-markers.json"))).toBe(true);
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(/sentinel/i);
    // The fakes' output was parsed, and reduced to classes.
    const a06 = JSON.parse(
      readFileSync(join(scratchDir, "results", "a06-headless.json"), "utf8"),
    ) as { runs: { host: string; session: Record<string, unknown> }[] };
    const claudeRun = a06.runs.find((r) => r.host === "Claude Code CLI")?.session;
    expect(claudeRun?.["models"]).toEqual(["claude-haiku-5-5", "[other]", "[other]"]);
    expect(claudeRun?.["subtype"]).toBe("[other]");
    expect(claudeRun?.["is_error"]).toBeNull();
    const codexRun = a06.runs.find((r) => r.host === "Codex CLI")?.session;
    expect(codexRun?.["errors"]).toEqual(["other", "other"]);
    expect(codexRun?.["items"]).toEqual([
      {
        type: "mcp_tool_call",
        server: "[other]",
        tool: "[other]",
        status: "[other]",
        error: "other",
      },
      { type: "command_execution", exit_code: 1, status: "failed", output_class: "other" },
      { type: "[other]" },
    ]);
    expect(codexRun?.["usage"]).toEqual({
      input_tokens: 10,
      cached_input_tokens: 2,
      cache_write_input_tokens: null,
      output_tokens: null,
      reasoning_output_tokens: null,
    });
  }, 180_000);

  test("the error boundary prints an error class, never the message or a path", async () => {
    const fakes = join(tmp, "fake-clis-2");
    mkdirSync(fakes, { recursive: true });
    writeFileSync(join(fakes, "claude.mjs"), FAKE_CLAUDE);
    writeFileSync(join(fakes, "codex.mjs"), FAKE_CODEX);
    // The fake codex writes no config.toml, so the lab's read fails with a path in its message.
    const scratchDir = join(tmp, "sentinel-user-q7x", "m0-09");
    const r = await labRun(["a02-config", "--scratch", scratchDir], { TTASKS_M0_TEST_CLIS: fakes });
    expect(r.code).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toMatch(/error: Error ENOENT/);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/sentinel/i);
    // A refusal at the top of the program (an existing folder that is not the lab's scratch).
    const foreign = join(tmp, "sentinel-user-q7x", "foreign");
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, "keep.txt"), "keep");
    const top = await labRun(["help", "--scratch", foreign]);
    expect(top.code).toBe(1);
    expect(top.stderr).toContain("error: scratch root exists without the lab's marker");
    expect(`${top.stdout}${top.stderr}`).not.toMatch(/sentinel/i);
    expect(readdirSync(foreign)).toEqual(["keep.txt"]);
    // The probe's boundary: an unreadable expectation file named by a sentinel path.
    const probe = await run(
      process.execPath,
      [
        PROBE,
        "--out",
        join(tmp, "p-out"),
        "--label",
        "b",
        "--expect",
        join(scratchDir, "none.json"),
      ],
      { env: cleanEnv(process.env), cwd: tmp, timeoutMs: 30_000 },
    );
    expect(probe.code).toBe(70);
    expect(probe.stderr).toMatch(/probe: error Error ENOENT/);
    expect(`${probe.stdout}${probe.stderr}`).not.toMatch(/sentinel/i);
  }, 60_000);

  // Finding 5: one cleanup path, a bounded graceful wait, then a forced end.
  test("a child that ignores the graceful signal is forced to end at the timeout", async () => {
    const t0 = Date.now();
    const r = await run(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);console.log('up')"],
      { env: cleanEnv(process.env), cwd: tmp, timeoutMs: 1500, graceMs: 1000 },
    );
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(alive(r.pid)).toBe(false);
    expect(liveChildren()).toBe(0);
  }, 30_000);

  test("a grandchild that keeps the pipe open neither hangs the run nor outlives a timeout", async () => {
    const pidFile = join(tmp, "grandchild.pid");
    const grand = `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
    // The child starts the grandchild with the same stdio (it holds the pipes) and stays alive.
    const script = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grand)}],{stdio:'inherit'});setInterval(()=>{},1000)`;
    const t0 = Date.now();
    const r = await run(process.execPath, ["-e", script], {
      env: cleanEnv(process.env),
      cwd: tmp,
      timeoutMs: 2500,
      graceMs: 1000,
      closeWaitMs: 1000,
    });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(20_000);
    const grandPid = Number(readFileSync(pidFile, "utf8"));
    await new Promise((res) => setTimeout(res, 500));
    expect(alive(r.pid)).toBe(false);
    expect(alive(grandPid)).toBe(false);
  }, 40_000);

  test("a child that exits while its grandchild holds the pipe: the run still returns", async () => {
    const pidFile = join(tmp, "grandchild2.pid");
    const grand = `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>{},20000)`;
    const script = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grand)}],{stdio:'inherit'});setTimeout(()=>process.exit(0),300)`;
    const t0 = Date.now();
    const r = await run(process.execPath, ["-e", script], {
      env: cleanEnv(process.env),
      cwd: tmp,
      timeoutMs: 15_000,
      closeWaitMs: 1000,
    });
    expect(r.code).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(Date.now() - t0).toBeLessThan(10_000);
    const grandPid = Number(readFileSync(pidFile, "utf8"));
    await new Promise((res) => setTimeout(res, 300));
    if (process.platform !== "win32") expect(alive(grandPid)).toBe(false);
    // On Windows the group cannot be ended once its parent is gone: the test ends it by its PID.
    if (alive(grandPid)) process.kill(grandPid);
  }, 30_000);

  test("endAll ends every child the run started", async () => {
    const pending = run(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      env: cleanEnv(process.env),
      cwd: tmp,
      timeoutMs: 60_000,
      graceMs: 1000,
    });
    await new Promise((res) => setTimeout(res, 500));
    expect(liveChildren()).toBe(1);
    await endAll(1000);
    const r = await pending;
    expect(alive(r.pid)).toBe(false);
    expect(liveChildren()).toBe(0);
  }, 30_000);

  test.skipIf(process.platform === "win32")(
    "SIGTERM to a program with the cleanup installed ends its children and their groups",
    async () => {
      const pidFile = join(tmp, "sig-child.pid");
      const prog = join(tmp, "sig-prog.mjs");
      writeFileSync(
        prog,
        `import { run, installCleanup } from ${JSON.stringify(pathToFileURL(join(HERE, "spawn.ts")).href)};
import { writeFileSync } from "node:fs";
installCleanup();
void run(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
  env: { PATH: process.env.PATH ?? "" }, cwd: process.cwd(), timeoutMs: 120000, graceMs: 1000,
  onPid: (pid) => writeFileSync(${JSON.stringify(pidFile)}, String(pid)),
});
setInterval(() => {}, 1000);
`,
      );
      const parent = spawn(process.execPath, [prog], { cwd: tmp, stdio: "ignore" });
      for (let i = 0; i < 100 && !existsSync(pidFile); i++)
        await new Promise((r) => setTimeout(r, 100));
      const childPid = Number(readFileSync(pidFile, "utf8"));
      expect(alive(childPid)).toBe(true);
      parent.kill("SIGTERM");
      const code = await new Promise<number | null>((r) =>
        parent.on("exit", (c) => {
          r(c);
        }),
      );
      expect(code).toBe(143);
      expect(alive(childPid)).toBe(false);
    },
    30_000,
  );

  test("the estimator, the share and the divisor search", () => {
    expect(estimate("abcdef")).toBe(2);
    expect(estimate("ü")).toBe(1);
    const rows = [
      { bytes: 30, real: 10 },
      { bytes: 30, real: 15 },
    ];
    expect(share(rows, 3)).toBe(0.5);
    expect(divisorFor(rows, 1)).toBe(2.1);
  });
});
