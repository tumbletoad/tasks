// The recorded Claude Code print-mode exchanges hold nothing of the person or the machine they
// were recorded on: every string is one the sanitiser can write, and the shape scan of the stream
// fixtures finds no home path, address, token or name of the machine the check runs on.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../../scripts/run.ts";
import { checkContent, checkJsonContent, machineDenyList } from "../stream-content.ts";
import { checkFixture, FIXTURE_TEXT, FIXTURE_WORK, sanitiseRecording } from "./sanitise.ts";

const ROOT = join(repoRoot, "fixtures", "claude-stream");
const fixtures = (): string[] =>
  readdirSync(ROOT)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();

describe("[A4.3.11.claude-stream.fixture-content] the Claude Code print-mode recordings", () => {
  it("every committed fixture holds only what the sanitiser writes, and passes the scan", () => {
    const machine = machineDenyList();
    expect(fixtures().length).toBeGreaterThanOrEqual(8);
    for (const name of fixtures()) {
      const text = readFileSync(join(ROOT, name), "utf8");
      expect(checkFixture(text), name).toEqual([]);
      expect(checkContent(text, machine, true), name).toEqual([]);
      for (const line of text.split("\n").filter((l) => l !== "")) {
        expect(checkJsonContent(JSON.parse(line), machine), name).toEqual([]);
      }
    }
  });

  it("the sanitiser keeps the protocol and drops what a recording says about its machine and its person", () => {
    const work = "C:\\Users\\someone\\scratch\\work-plain";
    const raw = [
      {
        dir: "recv",
        ms: 3,
        msg: {
          type: "system",
          subtype: "init",
          cwd: work,
          session_id: "019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5b",
          tools: ["Bash", "mcp__acme-crm__lookup"],
          mcp_servers: [
            { name: "acme-crm", status: "connected" },
            { name: "ttasks", status: "pending" },
          ],
          skills: ["someone-private-skill"],
          model: "claude-haiku-9",
          claude_code_version: "2.1.325",
          messaging_socket_path: "\\\\.\\pipe\\BOX-17-socket",
        },
      },
      {
        dir: "recv",
        ms: 6,
        msg: {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Mail mira@example.org the key sk-ant-api03-abcdefghijklmnop",
          modelUsage: { "claude-haiku-9": { inputTokens: 1234 } },
          credential_expires_at: "2026-12-15T17:28:56.360Z",
        },
      },
      { dir: "stderr", ms: 8, msg: { text: "C:\\Users\\someone\\.claude\\settings.json is odd" } },
    ];
    const fixture = sanitiseRecording(raw.map((l) => JSON.stringify(l)).join("\n"), work);
    expect(checkFixture(fixture)).toEqual([]);
    expect(
      checkContent(fixture, [
        { label: "user", value: "someone" },
        { label: "host", value: "BOX-17" },
      ]),
    ).toEqual([]);
    for (const leak of ["acme", "private", "mira", "sk-ant", "019a1b2c", "1234", "haiku-9"]) {
      expect(fixture).not.toContain(leak);
    }
    const lines = fixture
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { msg: Record<string, unknown> });
    expect(lines[0]?.msg).toMatchObject({
      type: "system",
      subtype: "init",
      cwd: FIXTURE_WORK,
      tools: ["Bash", "fixture-tool-1"],
      mcp_servers: [
        { name: "fixture-server-1", status: "connected" },
        { name: "ttasks", status: "pending" },
      ],
      claude_code_version: "2.1.325",
    });
    expect(lines[1]?.msg).toMatchObject({ type: "result", result: FIXTURE_TEXT });
  });

  it("the check refuses a value the sanitiser would not write", () => {
    const line = (msg: object) => `${JSON.stringify({ dir: "recv", ms: 1, msg })}\n`;
    expect(checkFixture(line({ type: "result", subtype: "success" }))).toEqual([]);
    expect(checkFixture(line({ type: "result", result: "Ask Acme first" }))).not.toEqual([]);
    expect(checkFixture(line({ type: "system", cwd: "C:\\code\\portal" }))).not.toEqual([]);
    expect(checkFixture(line({ session_id: "019a1b2c-3d4e" }))).not.toEqual([]);
  });
});
