// The Codex the end-to-end tests' runs start: the run driver's fake app server
// (packages/runs/test/codex-server.ts), which replays a real `codex app-server` recording, with the
// case each run plays picked by the test (codex-cases.ts). A test names the cases of a task's next
// runs in the task's own JSON file (`<FAKE_CODEX_CASES>/<reference>.json`, a list), and each run of
// the task takes the first that is left; a run with none left answers.
//
// It runs as `node fake-codex.ts app-server` in the task's folder, as the instance's program.
// Fixture data only. Tests only.
// First: this script ends through process.exit.
import "../../packages/bridge/src/safe-exit.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { atomicWrite } from "../../packages/files/src/index.ts";
import { ADDED } from "../../packages/launch/src/index.ts";
import {
  readFixture,
  serveCodex,
  type FakeScenario,
} from "../../packages/runs/test/codex-server.ts";
import { fakeAnswer, FAKE_QUESTION, FAKE_SIGNED_OUT, type FakeCodexCase } from "./codex-cases.ts";

/** The case this run plays: the first left for its task, taken from the task's file. */
function take(folder: string | undefined, task: string | undefined): FakeCodexCase {
  if (folder === undefined || task === undefined) return "answer";
  const file = join(folder, `${task}.json`);
  let cases: FakeCodexCase[];
  try {
    cases = JSON.parse(readFileSync(file, "utf8")) as FakeCodexCase[];
  } catch {
    return "answer";
  }
  const [next, ...rest] = cases;
  // Whole or not at all: the test reads the file while the run takes its case.
  atomicWrite(file, JSON.stringify(rest));
  return next ?? "answer";
}

/** The recorded turn's ID, which the driver knows the turn by. */
function recordedTurn(fixture: string): string {
  for (const line of readFixture(fixture)) {
    const params = line.msg["params"] as { turn?: { id?: unknown } } | undefined;
    if (line.msg["method"] === "turn/started" && typeof params?.turn?.id === "string") {
      return params.turn.id;
    }
  }
  throw new Error(`${fixture} has no turn`);
}

function scenarioOf(chosen: FakeCodexCase): {
  -readonly [K in keyof FakeScenario]: FakeScenario[K];
} {
  switch (chosen) {
    case "hold":
      return { fixture: "windows-interrupt" };
    case "ask":
      return {
        fixture: "windows-plain",
        requests: [
          {
            method: "item/tool/requestUserInput",
            params: {
              itemId: "fake-question",
              isBlocking: true,
              questions: [
                {
                  id: "month",
                  header: "Month",
                  question: FAKE_QUESTION,
                  options: [{ label: "October" }, { label: "November" }],
                },
              ],
            },
          },
        ],
      };
    case "fail":
      return {
        fixture: "windows-plain",
        notifications: [
          {
            method: "turn/completed",
            params: {
              turn: {
                id: recordedTurn("windows-plain"),
                items: [],
                status: "failed",
                error: { message: FAKE_SIGNED_OUT },
              },
            },
          },
        ],
      };
    default:
      return { fixture: "windows-plain" };
  }
}

const chosen = take(process.env["FAKE_CODEX_CASES"], process.env[ADDED.task]);
const scenario = { ...scenarioOf(chosen), cwd: process.cwd() };
// The request reaches the server in `turn/start`, never on its command line: the answer is made
// from it as it arrives, before the replay sends the answer.
const input = new PassThrough();
let rest = "";
process.stdin.on("data", (chunk: Buffer) => {
  rest += chunk.toString("utf8");
  let at = rest.indexOf("\n");
  while (at >= 0) {
    const line = rest.slice(0, at);
    rest = rest.slice(at + 1);
    try {
      const message = JSON.parse(line) as {
        method?: string;
        params?: { input?: { text?: string }[] };
      };
      const brief = message.params?.input?.[0]?.text;
      if (message.method === "turn/start" && typeof brief === "string") {
        const request = brief.slice(brief.lastIndexOf("\n\n") + 2);
        scenario.answer = fakeAnswer(request, chosen === "long");
      }
    } catch {
      // Not a message.
    }
    at = rest.indexOf("\n");
  }
  input.write(chunk);
});
process.stdin.on("end", () => {
  input.end();
});
// Never outlives ten minutes, so a run a test leaves cannot keep it for long.
setTimeout(() => process.exit(124), 600_000).unref();
const fake = serveCodex(input, process.stdout, scenario);
process.exit(await fake.done);
