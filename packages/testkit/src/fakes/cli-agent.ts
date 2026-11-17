// A fake Claude Code or Codex CLI (A4 3.4.2, 3.4.3; M2.10): what a launch's shim starts in place
// of the real agent. It takes any argv, as the real CLIs do, and is steered by its environment,
// which a test sets through the instance's `env` in machine.toml:
// - FAKE_CLI_REPORT: a file to write its report to: its whole argv exactly as it got it (as text,
//   and each argument's UTF-8 and UTF-16 code units in hex, so a test compares them byte for
//   byte), the folder it started in (as a path and by identity), and its environment's names.
// - FAKE_CLI_ROLLOUT_HOME: a Codex home: it writes a session file there as A4 3.4.3 describes
//   Codex's (its session record with the folder `-C` named, then the prompt after `--` as the
//   user's first message), for the reference match.
// - FAKE_CLI_TASKS: `{"argv": [...], "home": "..."}`, the product's command and the install's home
//   (TASKS_HOME): it reads the task as its brief says when the tools are missing, `show --launch
//   <reference>` with `--json`, and its report holds the request it got, in hex, so a test finds
//   the words nowhere else on disk.
// - FAKE_CLI_HOLD_MS (default 4000), FAKE_CLI_RELEASE (a file whose existence ends it),
//   FAKE_CLI_MAX_MS (default 120000) and FAKE_CLI_EXIT (default 0).
// Its stdin is never read. No real agent, account or home is touched. Tests only.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What the fake CLI writes to its report file. */
export interface CliAgentReport {
  readonly argv: string[];
  /** Each argument's UTF-8 bytes, in hex. */
  readonly utf8: string[];
  /** Each argument's UTF-16 code units, in hex, four digits each. */
  readonly utf16: string[];
  readonly cwd: string;
  /** `<dev>:<ino>` of the directory it started in, read through `.`. */
  readonly cwdId: string;
  readonly envNames: string[];
  /**
   * With FAKE_CLI_TASKS: the reading of the task, its exit code and the request it held (UTF-8, in
   * hex), or the error's code.
   */
  readonly read?: {
    readonly code: number | null;
    readonly request?: string;
    readonly error?: string;
  };
}

const startedIn = statSync(".", { bigint: true });
const argv = process.argv.slice(2);
const env = process.env;

/** The launch reference in the brief's first line, as an agent reads it. */
function referenceOf(args: readonly string[]): string | undefined {
  const brief = args[args.indexOf("--") + 1] ?? "";
  return /^\S.* \(launch (L[0-9A-Z]{5})\)\./u.exec(brief.split("\n")[0] ?? "")?.[1];
}

/** `show --launch <reference> --json` through the product's command, as the brief says. */
function readTask(spec: string): CliAgentReport["read"] {
  const reference = referenceOf(argv);
  if (reference === undefined) return { code: null, error: "no_reference" };
  const { argv: command, home } = JSON.parse(spec) as { argv: string[]; home: string };
  const [file, ...rest] = command;
  if (file === undefined) return { code: null, error: "no_command" };
  const ran = spawnSync(file, [...rest, "show", "--launch", reference, "--json"], {
    env: { ...env, TASKS_HOME: home },
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  try {
    const result = JSON.parse(ran.stdout) as {
      request?: unknown;
      error?: { code?: unknown };
    };
    return {
      code: ran.status,
      ...(typeof result.request === "string"
        ? { request: Buffer.from(result.request, "utf8").toString("hex") }
        : {}),
      ...(typeof result.error?.code === "string" ? { error: result.error.code } : {}),
    };
  } catch {
    return { code: ran.status, error: "unreadable" };
  }
}

const tasks = env["FAKE_CLI_TASKS"];
const read = tasks === undefined || tasks === "" ? undefined : readTask(tasks);

const report = env["FAKE_CLI_REPORT"];
if (report !== undefined && report !== "") {
  const body: CliAgentReport = {
    argv,
    utf8: argv.map((arg) => Buffer.from(arg, "utf8").toString("hex")),
    utf16: argv.map((arg) =>
      Array.from({ length: arg.length }, (_, i) =>
        arg.charCodeAt(i).toString(16).padStart(4, "0"),
      ).join(""),
    ),
    cwd: process.cwd(),
    cwdId: `${startedIn.dev.toString()}:${startedIn.ino.toString()}`,
    envNames: Object.keys(env).sort(),
    ...(read === undefined ? {} : { read }),
  };
  writeFileSync(report, JSON.stringify(body));
}

const rolloutHome = env["FAKE_CLI_ROLLOUT_HOME"];
if (rolloutHome !== undefined && rolloutHome !== "") {
  const at = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const folder = join(
    rolloutHome,
    "sessions",
    String(at.getFullYear()),
    pad(at.getMonth() + 1),
    pad(at.getDate()),
  );
  mkdirSync(folder, { recursive: true });
  const thread = randomUUID();
  const cwdAt = argv.indexOf("-C");
  const promptAt = argv.indexOf("--");
  const lines: unknown[] = [
    {
      timestamp: at.toISOString(),
      type: "session_meta",
      payload: {
        id: thread,
        cwd: cwdAt === -1 ? process.cwd() : argv[cwdAt + 1],
        originator: "fake",
      },
    },
  ];
  if (promptAt !== -1) {
    lines.push({
      type: "event_msg",
      payload: { type: "user_message", message: argv.slice(promptAt + 1).join(" ") },
    });
  }
  const name = `rollout-${at.toISOString().replace(/[:.]/gu, "-")}-${thread}.jsonl`;
  writeFileSync(join(folder, name), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

const code = Number(env["FAKE_CLI_EXIT"] ?? "0");
const hold = Number(env["FAKE_CLI_HOLD_MS"] ?? "4000");
const max = Number(env["FAKE_CLI_MAX_MS"] ?? "120000");
const release = env["FAKE_CLI_RELEASE"];
const started = Date.now();
const timer = setInterval(() => {
  const ran = Date.now() - started;
  const released = release !== undefined && release !== "" && existsSync(release);
  if (ran >= max || ((release === undefined || release === "") && ran >= hold) || released) {
    clearInterval(timer);
    process.exit(code);
  }
}, 25);
