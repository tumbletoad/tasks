// A fake agent CLI for the self-test of lab run N (M0.11). No test starts a real claude or codex.
//   node fake-cli.ts <mode>
// Modes: `ok` (three events, exit 0), `slow` (init, a tool call that never answers, a grandchild
// that idles; Ctrl+C or SIGINT ends the turn with a result event and exit 130), `brief` (exit 1
// when stdin is empty), `partial` (a last line without its newline, then it waits to be killed).
import { spawn } from "node:child_process";

const mode = process.argv[2] ?? "ok";
const emit = (event: object) => process.stdout.write(`${JSON.stringify(event)}\n`);

let brief = "";
process.stdin.setEncoding("utf8").on("data", (d: string) => (brief += d));
process.stdin.on("end", () => {
  if (mode === "brief" && brief.trim() === "") {
    process.stderr.write("fake: no brief\n");
    process.exit(1);
  }
  emit({ type: "system", subtype: "init", session_id: "11111111-2222-4333-8444-555555555555" });
  if (mode === "ok" || mode === "brief") {
    emit({ type: "assistant", message: { content: [{ type: "text", text: "Fixture text." }] } });
    emit({ type: "result", subtype: "success", is_error: false });
    process.exit(0);
  }
  if (mode === "partial") {
    process.stdout.write('{"type":"assistant","message":{"content":[{"type":"te');
    setInterval(() => undefined, 1_000);
    return;
  }
  // slow: a grandchild that idles, then a tool call that never answers.
  spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const stop = (why: string) => {
    emit({ type: "result", subtype: "error_during_execution", is_error: true, reason: why });
    process.exit(130);
  };
  process.on("SIGINT", () => stop("interrupt"));
  process.on("SIGBREAK", () => stop("break"));
  setTimeout(() => emit({ type: "assistant", message: { content: [{ type: "tool_use" }] } }), 200);
  setInterval(() => undefined, 1_000);
});
