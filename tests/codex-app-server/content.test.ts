// The recorded `codex app-server` exchanges hold nothing of the person or the machine they were
// recorded on: every string is one the sanitiser can write, and the shape scan of the stream
// fixtures finds no home path, address, token or name of the machine the check runs on.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../../scripts/run.ts";
import { checkContent, checkJsonContent, machineDenyList } from "../stream-content.ts";
import { checkFixture, FIXTURE_TEXT, FIXTURE_WORK, sanitiseRecording } from "./sanitise.ts";

const ROOT = join(repoRoot, "fixtures", "codex-app-server");
const fixtures = (): string[] =>
  readdirSync(ROOT)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();

describe("[A4.3.11.codex-app-server.fixture-content] the app-server recordings", () => {
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

  it("the sanitiser keeps the protocol and drops what a recording says about its machine", () => {
    const work = "C:\\Users\\someone\\scratch\\work-plain";
    const raw = [
      {
        dir: "recv",
        ms: 3,
        msg: {
          id: 1,
          result: {
            userAgent: "ttasks_lab/0.169.0 (Windows NT 99.0.1; x86_64) unknown",
            codexHome: "C:\\Users\\someone\\.codex",
            platformOs: "windows",
          },
        },
      },
      {
        dir: "recv",
        ms: 4,
        msg: {
          method: "remoteControl/status/changed",
          params: { status: "disabled", serverName: "BOX-17", installationId: "c1a961b3-de6c" },
        },
      },
      {
        dir: "recv",
        ms: 5,
        msg: { method: "account/updated", params: { authMode: "chatgpt", planType: "team-acme" } },
      },
      {
        dir: "recv",
        ms: 6,
        msg: {
          method: "item/completed",
          params: {
            threadId: "019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5b",
            item: {
              type: "agentMessage",
              id: "msg_1",
              text: "Mail mira@example.org the key sk-ant-api03-abcdefghijklmnop",
              phase: "final_answer",
              cwd: work,
            },
            startedAtMs: 1_794_909_996_943,
          },
        },
      },
      {
        dir: "send",
        ms: 7,
        msg: {
          id: 2,
          method: "thread/start",
          params: {
            config: {
              "mcp_servers.ttasks": {
                command: "C:\\Users\\someone\\node.exe",
                args: ["C:\\Users\\someone\\stub.ts"],
                env: { TTASKS_TICKET: "REALTICKET" },
              },
            },
          },
        },
      },
      { dir: "stderr", ms: 8, msg: { text: "C:\\Users\\someone\\.codex\\config.toml is odd" } },
    ];
    const fixture = sanitiseRecording(raw.map((l) => JSON.stringify(l)).join("\n"), work);
    expect(checkFixture(fixture)).toEqual([]);
    expect(
      checkContent(fixture, [
        { label: "user", value: "someone" },
        { label: "host", value: "BOX-17" },
      ]),
    ).toEqual([]);
    for (const leak of ["acme", "REALTICKET", "99.0.1", "c1a961b3", "019a1b2c"]) {
      expect(fixture).not.toContain(leak);
    }
    const lines = fixture
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { msg: Record<string, unknown> });
    expect(lines[0]?.msg["result"]).toMatchObject({
      userAgent: "ttasks_lab/0.169.0 (fixture)",
      platformOs: "windows",
    });
    const item = (lines[3]?.msg["params"] as { item: Record<string, unknown> }).item;
    expect(item).toMatchObject({
      type: "agentMessage",
      phase: "final_answer",
      text: FIXTURE_TEXT,
      cwd: FIXTURE_WORK,
    });
  });

  it("the check refuses a value the sanitiser would not write", () => {
    const line = (msg: object) => `${JSON.stringify({ dir: "recv", ms: 1, msg })}\n`;
    expect(
      checkFixture(line({ method: "turn/completed", params: { status: "completed" } })),
    ).toEqual([]);
    expect(
      checkFixture(line({ method: "item/completed", params: { text: "Ask Acme first" } })),
    ).not.toEqual([]);
    expect(checkFixture(line({ params: { cwd: "C:\\code\\portal" } }))).not.toEqual([]);
    expect(checkFixture(line({ params: { threadId: "019a1b2c-3d4e" } }))).not.toEqual([]);
  });
});
