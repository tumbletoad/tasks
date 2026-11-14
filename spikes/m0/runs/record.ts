// The recorder of lab run N (M0.11). It starts one CLI through the clean spawner's environment
// rules (spikes/m0/agents/spawn.ts), feeds the brief on stdin and closes it, and writes the raw
// stdout and stderr byte for byte into the scratch folder only. Optionally it cancels the run when
// a stdout line matches, the way A4 3.11.8 would: a console control event through the
// console-ctrl helper, `taskkill /T` without /F, TerminateProcess, or a signal to the Unix process
// group. It records exit code, signal, timings, the line structure, the process tree before the
// cancel and what was left of it afterwards, and sweeps what was left (descendants of a PID the
// recorder started, identified by PID, executable name and start time).
//
// The child goes through lab run A's one cleanup path (spikes/m0/agents/spawn.ts): it is tracked,
// so the lab's SIGINT and SIGTERM handler ends it, and a timeout, a spawn error (a missing
// executable) and a normal end all leave through the same `finally`: the timer is cleared, the
// raw files are closed, and a child that is still tracked is ended.
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { LabError } from "../agents/facts.ts";
import { endChild, forbiddenNames, track } from "../agents/spawn.ts";
import { eventKeyOf, type CliKind } from "../../../tests/stream-schema.ts";
import { descendants, listProcesses, survivors, sweep, type Proc } from "./tree.ts";

export type CancelHow =
  "ctrl-c" | "ctrl-break" | "terminate" | "taskkill-tree" | "sigint-group" | "sigterm-group";

export interface CancelPlan {
  how: CancelHow;
  /** The stdout line (without its newline) that triggers the cancel. */
  trigger: (line: string) => boolean;
  /** Wait this long after the trigger line before cancelling. */
  delayMs?: number;
  /** Time to exit after the cancel before the recorder forces the tree (A4 3.11.8: 10 s). */
  graceMs?: number;
}

export interface RecordOptions {
  label: string;
  /** Which CLI's stream this is: event keys come from its schema only. */
  cli: CliKind;
  file: string;
  args: readonly string[];
  env: Record<string, string>;
  cwd: string;
  stdin: string;
  /** Folder for the raw files: always inside the scratch folder. */
  rawDir: string;
  timeoutMs?: number;
  cancel?: CancelPlan;
  /** Windows: the console-ctrl executable (needed for ctrl events and process lists). */
  helper?: string;
  onPid?: (pid: number) => void;
  /** Called with every PID the recorder sweeps after the run. */
  onSweep?: (procs: Proc[]) => void;
}

export interface CancelRecord {
  how: CancelHow;
  trigger_line: number;
  sent_ms: number;
  action_exit: number | null;
  action_class: string;
  exit_after_cancel_ms: number | null;
  escalated: boolean;
  lines_after_cancel: number;
  tree_before: { pid: number; exe: string }[];
  left_after_exit: { pid: number; exe: string }[];
}

export interface Recording {
  label: string;
  pid: number | undefined;
  exit: number | null;
  signal: string | null;
  ms: number;
  timed_out: boolean;
  first_line_ms: number | null;
  stdout_bytes: number;
  stderr_bytes: number;
  lines: number;
  json_lines: number;
  non_json_lines: number;
  ends_with_newline: boolean;
  partial_final_line: boolean;
  crlf_lines: number;
  event_keys: string[];
  /** Milliseconds from the 'exit' event to the stdout pipe's end. */
  stdout_end_after_exit_ms: number | null;
  cancel: CancelRecord | null;
  swept: { pid: number; exe: string }[];
  raw_stdout: string;
  raw_stderr: string;
}

/** An event's key from the fixture schema only (`unknown-event` for anything else). */
export function eventKey(cli: CliKind, value: unknown): string {
  return eventKeyOf(cli, value);
}

/** The class of a short helper or taskkill message, from a fixed list. */
export function actionClass(text: string): string {
  if (/forcefully|\/F option/i.test(text)) return "needs-force";
  if (/SUCCESS/.test(text)) return "success";
  if (/not found|no running instance/i.test(text)) return "not-found";
  if (/"sent":true/.test(text)) return "sent";
  if (/"foreign"/.test(text)) return "refused-foreign-process";
  if (/"list_failed"/.test(text)) return "refused-console-list-failed";
  if (/"attached":false/.test(text)) return "attach-failed";
  if (text.trim() === "") return "none";
  return "other";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tree(root: number, helper: string | undefined): Proc[] {
  try {
    return descendants(listProcesses(helper), root);
  } catch {
    return [];
  }
}

/** Sends the cancel. Returns the action's exit code and its class (never its text). */
function sendCancel(
  how: CancelHow,
  pid: number,
  kill: (signal?: NodeJS.Signals) => boolean,
  helper: string | undefined,
): { exit: number | null; cls: string } {
  switch (how) {
    case "ctrl-c":
    case "ctrl-break": {
      if (helper === undefined) throw new LabError("ctrl events need the console-ctrl helper");
      const r = spawnSync(helper, ["send", String(pid), how === "ctrl-c" ? "c" : "break"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
      });
      return { exit: r.status, cls: actionClass(`${r.stdout}${r.stderr}`) };
    }
    case "taskkill-tree": {
      const r = spawnSync("taskkill", ["/PID", String(pid), "/T"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
      });
      return { exit: r.status, cls: actionClass(`${r.stdout}${r.stderr}`) };
    }
    case "terminate":
      // Node on Windows: every signal name becomes TerminateProcess of this one process.
      return { exit: kill() ? 0 : 1, cls: "terminate" };
    case "sigint-group":
    case "sigterm-group":
      try {
        process.kill(-pid, how === "sigint-group" ? "SIGINT" : "SIGTERM");
        return { exit: 0, cls: "signalled" };
      } catch {
        return { exit: 1, cls: "not-found" };
      }
  }
}

/** Forces the whole tree: taskkill /T /F on Windows, SIGKILL to the group on Unix. */
function force(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      timeout: 15_000,
    });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

export async function record(o: RecordOptions): Promise<Recording> {
  const leaked = forbiddenNames(o.env);
  if (leaked.length > 0) throw new LabError("refusing to pass agent variables to a child");
  mkdirSync(o.rawDir, { recursive: true });
  const rawStdout = join(o.rawDir, `${o.label}.stdout.jsonl`);
  const rawStderr = join(o.rawDir, `${o.label}.stderr.txt`);
  const out = createWriteStream(rawStdout, { mode: 0o600 });
  const err = createWriteStream(rawStderr, { mode: 0o600 });
  const win = process.platform === "win32";

  const t0 = performance.now();
  const now = () => Math.round(performance.now() - t0);
  const child = spawn(o.file, [...o.args], {
    cwd: o.cwd,
    env: o.env,
    windowsHide: true,
    // Unix: the agent leads its own session and process group, as the run shim starts it.
    detached: !win,
    stdio: ["pipe", "pipe", "pipe"],
  });
  track(child, !win);
  const pid = child.pid;
  if (pid !== undefined) o.onPid?.(pid);

  let stdoutBytes = 0;
  let stderrBytes = 0;
  let pending = "";
  let lines = 0;
  let jsonLines = 0;
  let nonJson = 0;
  let crlf = 0;
  let firstLine: number | null = null;
  let lastChar = "";
  const keys: string[] = [];
  let cancel: CancelRecord | null = null;
  let treeBefore: Proc[] = [];
  let cancelStarted = false;
  // Mutable from callbacks, so in one object (the compiler cannot see callback writes to a `let`).
  const at: { exit: number | null; end: number | null } = { exit: null, end: null };
  const hasExited = () => at.exit !== null;

  const onLine = (line: string) => {
    lines++;
    firstLine ??= now();
    if (line.endsWith("\r")) crlf++;
    const text = line.replace(/\r$/, "");
    try {
      keys.push(eventKey(o.cli, JSON.parse(text)));
      jsonLines++;
    } catch {
      nonJson++;
    }
    if (cancel !== null) cancel.lines_after_cancel++;
    if (!cancelStarted && o.cancel !== undefined && pid !== undefined && o.cancel.trigger(text)) {
      cancelStarted = true;
      const plan = o.cancel;
      const triggerLine = lines;
      void (async () => {
        await sleep(plan.delayMs ?? 0);
        if (hasExited()) return;
        const before = tree(pid, o.helper);
        treeBefore = before;
        const sentAt = now();
        const action = sendCancel(plan.how, pid, (s) => child.kill(s), o.helper);
        cancel = {
          how: plan.how,
          trigger_line: triggerLine,
          sent_ms: sentAt,
          action_exit: action.exit,
          action_class: action.cls,
          exit_after_cancel_ms: null,
          escalated: false,
          lines_after_cancel: 0,
          tree_before: before.map((p) => ({ pid: p.pid, exe: p.exe })),
          left_after_exit: [],
        };
        const grace = plan.graceMs ?? 10_000;
        const deadline = performance.now() + grace;
        while (!hasExited() && performance.now() < deadline) await sleep(50);
        if (!hasExited()) {
          cancel.escalated = true;
          force(pid);
        }
      })();
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    out.write(chunk);
    stdoutBytes += chunk.length;
    const s = chunk.toString("utf8");
    lastChar = s.slice(-1);
    pending += s;
    let at = pending.indexOf("\n");
    while (at >= 0) {
      onLine(pending.slice(0, at));
      pending = pending.slice(at + 1);
      at = pending.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    err.write(chunk);
    stderrBytes += chunk.length;
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void endChild(child);
  }, o.timeoutMs ?? 240_000);

  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      at.exit = now();
      resolve({ code, signal });
    });
  });
  const ended = new Promise<void>((resolve) => {
    child.stdout.on("end", () => {
      at.end = now();
      resolve();
    });
  });
  child.stdin.on("error", () => {
    // The CLI may exit before it read stdin; the run's exit code says what happened.
  });
  child.stdin.end(o.stdin);

  let code: number | null;
  let signal: string | null;
  try {
    ({ code, signal } = await exited);
    // A grandchild that inherited the stdout pipe keeps it open after the leader is gone.
    await Promise.race([ended, sleep(5_000)]);
  } finally {
    // The one way out: after an exit, a timeout, or a spawn error such as a missing executable.
    clearTimeout(timer);
    if (at.end === null) {
      child.stdout.destroy();
      child.stderr.destroy();
    }
    await new Promise<void>((r) => out.end(r));
    await new Promise<void>((r) => err.end(r));
    // A spawn error or a throw before the exit: end the child now and drop it from the path.
    if (at.exit === null) await endChild(child, 0);
  }

  const c = cancel as CancelRecord | null;
  let swept: Proc[] = [];
  if (c !== null) {
    c.exit_after_cancel_ms = (at.exit ?? now()) - c.sent_ms;
    await sleep(1_000);
    let left: Proc[];
    try {
      left = survivors(treeBefore, listProcesses(o.helper));
    } catch {
      left = [];
    }
    c.left_after_exit = left.map((p) => ({ pid: p.pid, exe: p.exe }));
    if (left.length > 0) {
      o.onSweep?.(left);
      swept = sweep(left, o.helper);
    }
  }
  // After the measurement: what is left of the child's group goes, and the child leaves the path.
  await endChild(child, 0);
  return {
    label: o.label,
    pid,
    exit: code,
    signal,
    ms: at.exit ?? now(),
    timed_out: timedOut,
    first_line_ms: firstLine,
    stdout_bytes: stdoutBytes,
    stderr_bytes: stderrBytes,
    lines,
    json_lines: jsonLines,
    non_json_lines: nonJson,
    ends_with_newline: lastChar === "\n" || stdoutBytes === 0,
    partial_final_line: pending.length > 0,
    crlf_lines: crlf,
    event_keys: keys,
    stdout_end_after_exit_ms: at.end === null || at.exit === null ? null : at.end - at.exit,
    cancel: c,
    swept: swept.map((p) => ({ pid: p.pid, exe: p.exe })),
    raw_stdout: rawStdout,
    raw_stderr: rawStderr,
  };
}
