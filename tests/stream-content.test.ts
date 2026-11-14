// The content check on the committed stream fixtures (A7 3.7: M0.11 "Fixtures pass the content
// check", N05). Runs in CI on every machine, with a deny-list built from that machine. The text
// scan finds shapes and this machine's names; the structural assertions are the guarantee.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../scripts/run.ts";
import {
  checkContent,
  checkIndexStructure,
  checkInventoryStructure,
  checkJsonContent,
  checkStreamFixture,
  keyShaped,
  machineDenyList,
} from "./stream-content.ts";
import { checkEventStructure } from "./stream-schema.ts";

const ROOT = join(repoRoot, "fixtures", "streams");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}
const rel = (p: string) => relative(ROOT, p).replaceAll("\\", "/");
const streams = () => files(ROOT).filter((p) => p.endsWith(".jsonl"));

const deny = [
  { label: "user name", value: "someone" },
  { label: "host name", value: "box-17" },
];

describe("[A7.3.7.m0-runs.fixture-content] stream fixtures pass the content check", () => {
  it("finds every kind of leak it is meant to find in text", () => {
    const cases: [string, string][] = [
      ['{"cwd":"C:\\\\Users\\\\x\\\\work"}', "Windows home path"],
      ["C:/Users/x/work", "Windows home path"],
      ["C:\\Users", "Windows home path"],
      ['{"cwd":"/home/x/work"}', "Unix home path"],
      ["/home/x", "Unix home path"],
      ['{"p":"/Users/x"}', "Unix home path"],
      ['{"p":"/root/.codex"}', "root home path"],
      ['{"p":"/root"}', "root home path"],
      ["cd /root", "root home path"],
      ['{"p":"~/notes"}', "home shorthand path"],
      ['{"p":"\\\\\\\\server\\\\share"}', "UNC path"],
      ["mail me at a.b@example.org", "e-mail address"],
      ["key sk-ant-api03-abcdefghijklmnop", "known token or key prefix"],
      ["ghp_abcdefghijklmnopqrstuvwxyz0123", "known token or key prefix"],
      ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc", "JSON web token"],
      ["Authorization: Bearer abcdefghijklmnop", "bearer credential"],
      ["host 192.0.2.20 up", "IPv4 address"],
      ["host fe80::1c2b:3aff:fe4d:5e6f up", "IPv6 address"],
      ['{"ip":"2001:db8:85a3:0:0:8a2e:370:7334"}', "IPv6 address"],
      ["loopback ::1", "IPv6 address"],
      ["Q2xhdWRlIGlzIGF3ZXNvbWUgYW5kIGZ1bjEyMw9", "key-shaped string"],
      ["hello someone", "machine user name"],
      ["BOX-17 says hi", "machine host name"],
      // JSON escapes in text that cannot be parsed (a cut final line).
      ['{"p":"\\/home\\/x\\/w', "Unix home path"],
      ['{"p":"\\u002fhome\\u002fx', "Unix home path"],
      ['{"m":"a.b\\u0040example.org', "e-mail address"],
    ];
    for (const [text, label] of cases) expect(checkContent(text, deny), text).toContain(label);
    // Times, versions, fixture IDs and paths are none of these.
    const clean = [
      '{"session_id":"00000000-0000-4000-8000-000000000001","id":"toolu_fixture0008"}',
      '{"cwd":"C:\\\\fixture\\\\work","p":"/fixture/path-2","v":"2.1.322"}',
      '{"timestamp":"2026-01-01T00:00:00.000Z","t":"12:34:56"}',
      "/rooted/x and /root-like",
    ];
    for (const text of clean) expect(checkContent(text, deny), text).toEqual([]);
  });

  it("parses each line: decoded values are checked, and only keys get the camelCase allowance", () => {
    // JSON-escaped values decode before the check.
    expect(checkJsonContent(JSON.parse('{"p":"\\u002fhome\\u002fx"}'), deny)).toContain(
      "Unix home path",
    );
    expect(checkJsonContent(JSON.parse('{"m":"a\\u0040example.org"}'), deny)).toContain(
      "e-mail address",
    );
    expect(checkJsonContent({ p: "/root" }, deny)).toContain("root home path");
    expect(checkJsonContent({ ip: "fe80::1" }, deny)).toContain("IPv6 address");
    // A long camelCase run is fine as a field name and key-shaped as a value.
    const camel = "cacheCreationEphemeral5mInputTokensAndMore";
    expect(keyShaped(camel, true)).toBe(false);
    expect(keyShaped(camel)).toBe(true);
    expect(checkJsonContent({ [camel]: 0 }, deny)).toEqual([]);
    expect(checkJsonContent({ x: camel }, deny)).toContain("key-shaped string");
    // Keys are checked too.
    expect(checkJsonContent({ "someone@example.org": 1 }, deny)).toContain("e-mail address");
    expect(checkJsonContent({ a: { someone: 1 } }, deny)).toContain("machine user name");
  });

  it("the structure rejects observed values in allow-listed fields", () => {
    const init = {
      type: "system",
      subtype: "init",
      session_id: "00000000-0000-4000-8000-000000000001",
    };
    const bad: [string, unknown, string][] = [
      ["claude-print", { ...init, tools: ["AcmeInternalTool"] }, "tools"],
      ["claude-print", { ...init, capabilities: ["mcp__private__inbox"] }, "capabilities"],
      ["claude-print", { ...init, session_id: "a-real-session" }, "session_id"],
      ["claude-print", { ...init, model: "gpt-acme-tenant42" }, "model"],
      [
        "claude-print",
        { ...init, memory_paths: { "acme-notes": "C:\\fixture\\path-2" } },
        "<map-key>",
      ],
      ["claude-print", { ...init, permissionMode: "acme" }, "permissionMode"],
      ["claude-print", { ...init, extra: 1 }, "<field>"],
      ["claude-print", { type: "assistant", timestamp: "2025-03-04T05:06:07.000Z" }, "timestamp"],
      ["claude-print", { type: "assistant", request_id: 123456 }, "request_id"],
      [
        "claude-print",
        {
          type: "result",
          subtype: "success",
          modelUsage: { "gpt-acme-tenant42": { provider: "AcmeTenant", inputTokens: 7 } },
        },
        "modelUsage",
      ],
      [
        "claude-print",
        { type: "result", subtype: "success", total_cost_usd: 0.0123 },
        "total_cost_usd",
      ],
      ["claude-print", { type: "result", subtype: "success", result: "Done for Acme" }, "result"],
      ["claude-print", { type: "acme_private_event" }, "(event)"],
      [
        "codex-exec",
        { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "hi" } },
        "item.text",
      ],
      [
        "codex-exec",
        { type: "thread.started", thread_id: "019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5b" },
        "thread_id",
      ],
    ];
    for (const [cli, event, where] of bad) {
      const findings = checkEventStructure(cli as "claude-print", "windows", event);
      expect(findings.join("; "), where).toContain(where);
    }
    // Fixture values conform: here a Linux path in a Windows stream does not.
    expect(
      checkEventStructure("claude-print", "windows", { ...init, cwd: "C:\\fixture\\work" }),
    ).toEqual([]);
    expect(
      checkEventStructure("claude-print", "windows", { ...init, cwd: "/fixture/work" }),
    ).not.toEqual([]);
    expect(checkEventStructure("claude-print", "windows", { type: "unknown-event" })).toEqual([]);
  });

  it("checks inventories and indexes by their structure", () => {
    const inv = {
      "claude-print": {
        "system/init": {
          count: 1,
          fields: {
            cwd: { types: ["string"], treatment: ["fixture-path"] },
            "<unknown-1>": { types: ["string"], treatment: ["dropped"] },
            plugins: { types: ["array"], treatment: ["rebuilt-list"] },
          },
        },
      },
    };
    expect(checkInventoryStructure(inv)).toEqual([]);
    const named = structuredClone(inv) as Record<string, Record<string, { fields: object }>>;
    (named["claude-print"]?.["system/init"]?.fields as Record<string, unknown>)[
      "extra.private-skill"
    ] = { types: ["string"], treatment: ["dropped"] };
    expect(checkInventoryStructure(named)).not.toEqual([]);
    expect(
      checkInventoryStructure({ "claude-print": { acme_private_event: { count: 1, fields: {} } } }),
    ).not.toEqual([]);
    const entry = {
      file: "codex-exec/linux-resume.jsonl",
      cli: "codex-exec",
      os: "linux",
      case: "codex exec resume <thread> - with another probe call",
      exit: 0,
      signal: null,
      cancel: null,
      escalated_to_force: null,
      stderr_class: "none",
      lines: 7,
      ends_with_newline: true,
      final_line: "complete",
    };
    expect(checkIndexStructure([entry])).toEqual([]);
    expect(checkIndexStructure([{ ...entry, stderr_class: "Acme login failed" }])).not.toEqual([]);
    expect(checkIndexStructure([{ ...entry, extra: 1 }])).not.toEqual([]);
  });

  it("builds its deny-list from this machine: user, host and home folder", () => {
    const labels = machineDenyList().map((e) => e.label);
    expect(labels).toContain("host name");
    expect(labels).toContain("home folder");
  });

  it("every committed stream fixture passes the scan and the structural assertions", () => {
    const machine = machineDenyList();
    const all = streams();
    expect(all.some((f) => rel(f).startsWith("claude-print/"))).toBe(true);
    expect(all.some((f) => rel(f).startsWith("codex-exec/"))).toBe(true);
    for (const f of all) {
      expect(checkStreamFixture(rel(f), readFileSync(f, "utf8"), machine), rel(f)).toEqual([]);
    }
  });

  it("every committed inventory and index passes the scan and its structure", () => {
    const machine = machineDenyList();
    for (const f of files(ROOT).filter((p) => p.endsWith(".json"))) {
      const text = readFileSync(f, "utf8");
      const value = JSON.parse(text) as unknown;
      expect(checkContent(text, machine, true), rel(f)).toEqual([]);
      expect(checkJsonContent(value, machine), rel(f)).toEqual([]);
      const structure = rel(f).startsWith("fields-")
        ? checkInventoryStructure(value)
        : rel(f).startsWith("index-")
          ? checkIndexStructure(value)
          : ["an unexpected file"];
      expect(structure, rel(f)).toEqual([]);
    }
  });

  it("every fixture line is one JSON object, except the cut final line of a truncated fixture", () => {
    for (const f of streams()) {
      const text = readFileSync(f, "utf8");
      const lines = text.split("\n");
      const tail = lines.pop() ?? "";
      for (const line of lines) {
        const value = JSON.parse(line) as unknown;
        expect(typeof value === "object" && value !== null && !Array.isArray(value)).toBe(true);
      }
      if (f.includes("truncated-final-line")) {
        expect(tail).not.toBe("");
        expect(() => JSON.parse(tail) as unknown).toThrow();
      } else expect(tail).toBe("");
    }
  });

  it("a truncated fixture is its source stream with the last line cut (README rule)", () => {
    for (const f of streams().filter((p) => p.includes("truncated-final-line"))) {
      const r = rel(f);
      const source = r.includes("/linux-")
        ? r.replace("killed-truncated-final-line", "cancel-sigterm-group")
        : r.replace("killed-truncated-final-line", "cancel-terminate");
      const cut = readFileSync(f, "utf8").split("\n");
      const tail = cut.pop() ?? "";
      const full = readFileSync(join(ROOT, source), "utf8").split("\n");
      full.pop();
      const last = full.pop() ?? "";
      expect(cut, r).toEqual(full);
      expect(last.startsWith(tail) && tail.length < last.length, r).toBe(true);
    }
  });
});
